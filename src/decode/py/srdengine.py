##
## Session driver for the sigrokdecode shim.
##
## Mirrors what libsigrokdecode's srd_inst_new / srd_session_start /
## srd_inst_decode do, minus the threading: options and the channel map are
## installed on the instance, metadata() runs before start() (24 stock
## decoders read self.samplerate inside start()), then decode() runs once
## over the whole sample range and terminates on EOFError.
##

import array
import decimal
import importlib
import sys
import traceback

import sigrokdecode as srd

INT32_MAX = 2 ** 31


class DecoderLoadError(Exception):
    pass


_loaded = {}


def load(dec_id):
    """Import a stock decoder package and return its Decoder class."""
    if dec_id in _loaded:
        return _loaded[dec_id]
    mod = importlib.import_module(dec_id)
    cls = getattr(mod, 'Decoder', None)
    if cls is None:
        raise DecoderLoadError('%s has no Decoder class' % dec_id)
    if not issubclass(cls, srd.Decoder):
        raise DecoderLoadError('%s.Decoder is not an srd.Decoder' % dec_id)
    api = getattr(cls, 'api_version', None)
    if api != 3:
        raise DecoderLoadError('%s has unsupported api_version %r' % (dec_id, api))
    _loaded[dec_id] = cls
    return cls


def _chan_list(cls, attr):
    out = []
    for c in getattr(cls, attr, ()) or ():
        out.append({'id': c['id'], 'name': c.get('name', c['id']),
                    'desc': c.get('desc', '')})
    return out


def describe(dec_id):
    """Everything the UI needs to offer a decoder, mirroring struct srd_decoder."""
    cls = load(dec_id)
    opts = []
    for o in getattr(cls, 'options', ()) or ():
        d = o.get('default')
        opts.append({
            'id': o['id'],
            'desc': o.get('desc', ''),
            'default': d,
            'type': 'int' if isinstance(d, int) and not isinstance(d, bool) else
                    ('float' if isinstance(d, float) else 'str'),
            'values': list(o.get('values', ()) or ()),
        })
    anns = [{'id': a[0], 'desc': a[1]} for a in getattr(cls, 'annotations', ()) or ()]
    rows = []
    for r in getattr(cls, 'annotation_rows', ()) or ():
        rows.append({'id': r[0], 'desc': r[1], 'classes': list(r[2])})
    # No synthesis here. libsigrokdecode's get_annotation_rows() (decoder.c:474)
    # returns SRD_OK with an empty list when the class has no annotation_rows
    # member, so 17 of the 131 stock decoders genuinely have none. Inventing
    # rows would make describe() disagree with the reference. The UI fallback
    # lives in registry.ts displayRows(), where it is labelled as a UI choice.
    return {
        'id': dec_id,
        'name': getattr(cls, 'name', dec_id),
        'longname': getattr(cls, 'longname', ''),
        'desc': getattr(cls, 'desc', ''),
        'license': getattr(cls, 'license', ''),
        'inputs': list(getattr(cls, 'inputs', ()) or ()),
        'outputs': list(getattr(cls, 'outputs', ()) or ()),
        'tags': list(getattr(cls, 'tags', ()) or ()),
        'channels': _chan_list(cls, 'channels'),
        'optional_channels': _chan_list(cls, 'optional_channels'),
        'options': opts,
        'annotations': anns,
        'annotation_rows': rows,
        'binary': [{'id': b[0], 'desc': b[1]} for b in getattr(cls, 'binary', ()) or ()],
    }


class Session:
    """One decode run over one sample range."""

    def __init__(self, samplerate, length, signals, eof_mode='raise'):
        """signals: list of (edges_list, initial_level) indexed by capture channel.

        eof_mode='raise'     deliver EOFError at end of data, so a decoder's
                             trailing flush runs and the last item of a capture
                             is kept. This is the default and what upstream
                             libsigrokdecode does when the frontend signals EOF.
        eof_mode='terminate' kill decode() at end of data with an uncatchable
                             exception, reproducing sigrok-cli 0.7.2 exactly.
                             Only 'parallel' is known to differ, by one
                             trailing annotation.
        """
        if eof_mode not in ('raise', 'terminate'):
            raise ValueError('eof_mode must be raise or terminate, got %r' % (eof_mode,))
        # Sample numbers are exported as int32 (see packed_results), so refuse
        # a range that cannot round-trip instead of raising OverflowError from
        # deep inside packing where the caller cannot tell what went wrong.
        if length >= INT32_MAX:
            raise ValueError(
                'range of %d samples exceeds the int32 annotation limit of %d; '
                'decode a sub-range' % (length, INT32_MAX - 1))
        self.eof_mode = eof_mode
        self.samplerate = samplerate
        self.length = length
        self.signals = [srd.Signal(e, init, length) for (e, init) in signals]
        self.insts = []
        self.ann_start = []
        self.ann_end = []
        self.ann_inst = []
        self.ann_class = []
        self.ann_texts = []

    # -- instance setup ------------------------------------------------------

    def add(self, dec_id, inst_id, channels, options, stack_on=None):
        """channels: {decoder_channel_index: capture_channel_index}
        stack_on: index into self.insts of the decoder feeding this one."""
        cls = load(dec_id)
        inst = cls()

        st = srd._Inst()
        st.inst_id = inst_id
        st.decoder_id = dec_id
        st.signals = self.signals
        st.length = self.length

        ncls = list(getattr(cls, 'channels', ()) or ())
        nopt = list(getattr(cls, 'optional_channels', ()) or ())
        st.num_channels = len(ncls) + len(nopt)
        st.channelmap = [-1] * st.num_channels
        for k, v in (channels or {}).items():
            k = int(k)
            if k < 0 or k >= st.num_channels:
                raise ValueError('%s: channel index %d out of range' % (dec_id, k))
            if v is None or int(v) < 0:
                continue
            if int(v) >= len(self.signals):
                raise ValueError('%s: capture channel %d not present' % (dec_id, v))
            st.channelmap[k] = int(v)
        # Required channels must be assigned - srd_inst_channel_set_all()
        # rejects the instance otherwise, and so do we, loudly.
        for i in range(len(ncls)):
            if st.channelmap[i] == -1 and stack_on is None:
                raise ValueError('%s: required channel "%s" not assigned'
                                 % (dec_id, ncls[i]['id']))

        st.eof_mode = self.eof_mode
        st.ann_sink = self._on_ann
        st.py_inst = inst
        inst._srd = st

        # self.options: a fresh dict of every declared option, defaults filled in.
        declared = getattr(cls, 'options', ()) or ()
        vals = {}
        for o in declared:
            dflt = o.get('default')
            if options and o['id'] in options:
                v = options[o['id']]
                if isinstance(dflt, str):
                    v = str(v)
                elif isinstance(dflt, bool):
                    v = bool(v)
                elif isinstance(dflt, int):
                    v = int(v)
                elif isinstance(dflt, float):
                    v = float(v)
                vals[o['id']] = v
            else:
                vals[o['id']] = dflt
        unknown = set(options or ()) - {o['id'] for o in declared}
        if unknown:
            raise ValueError('%s: unknown option(s) %s' % (dec_id, sorted(unknown)))
        inst.options = vals

        idx = len(self.insts)
        self.insts.append(inst)
        if stack_on is not None:
            self.insts[stack_on]._srd.next_di.append(st)
        st.stacked = stack_on is not None
        return idx

    # -- output sink ---------------------------------------------------------

    def _on_ann(self, st, ss, es, data):
        # data is [ann_class_index, [text, ...]] - convert_annotation() in
        # decoder.c enforces exactly that shape.
        self.ann_start.append(ss)
        self.ann_end.append(es)
        self.ann_inst.append(st.inst_index)
        self.ann_class.append(int(data[0]))
        self.ann_texts.append([str(x) for x in data[1]])

    # -- run -----------------------------------------------------------------

    def run(self):
        for i, inst in enumerate(self.insts):
            inst._srd.inst_index = i
        # Lifecycle order verified against sigrok-cli 0.7.2 with a probe
        # decoder (see NOTES.md): start() runs *before* metadata(), samplenum
        # and matched only exist after start() returns, and reset() is never
        # called on this path. Decoders that read self.samplerate in start()
        # are relying on their own class default; swim doesn't have one and
        # fails identically here and natively.
        for inst in self.insts:
            inst.start()
            inst.samplenum = 0
            inst.matched = None
        for inst in self.insts:
            if hasattr(inst, 'metadata'):
                inst.metadata(srd.SRD_CONF_SAMPLERATE, int(self.samplerate))

        errors = []
        # libsigrokdecode runs decode() on a per-stack worker thread, so any
        # thread-local state a decoder set up in __init__ or start() is NOT in
        # effect inside decode(). The one case that bites in practice is the
        # decimal context: lfast's __init__ sets ROUND_HALF_UP, which srd
        # silently drops, so srd rounds half-to-even. Reproduce that or lfast
        # disagrees with sigrok-cli on every exactly-half bit count.
        with decimal.localcontext(decimal.DefaultContext):
            self._run_decoders(errors)
        return errors

    def _run_decoders(self, errors):
        # Only the bottom-of-stack instances are sample driven; stacked ones
        # are driven by their producer's OUTPUT_PYTHON puts.
        for inst in self.insts:
            if inst._srd.stacked:
                continue
            try:
                inst.decode()
            except EOFError:
                pass
            except srd.Terminate:
                pass
            except Exception:
                errors.append('%s: %s' % (inst._srd.decoder_id,
                                          traceback.format_exc()))
        for inst in self.insts:
            if hasattr(inst, 'flush'):
                try:
                    inst.flush()
                except Exception:
                    errors.append('%s flush: %s' % (inst._srd.decoder_id,
                                                    traceback.format_exc()))

    def results(self):
        return {
            'start': self.ann_start,
            'end': self.ann_end,
            'inst': self.ann_inst,
            'cls': self.ann_class,
            'texts': self.ann_texts,
        }

    def packed_results(self):
        """Struct-of-arrays form for cheap transfer to the main thread.

        The numeric columns come back as raw little-endian buffers so JS can
        wrap them in typed arrays without walking them element by element;
        only the text pool crosses as real objects.
        """
        n = len(self.ann_start)
        start = array.array('i', self.ann_start)
        end = array.array('i', self.ann_end)
        inst = array.array('H', self.ann_inst)
        cls = array.array('H', self.ann_class)

        offs = array.array('i', bytes(4 * (n + 1)))
        pool = []
        acc = 0
        for i, texts in enumerate(self.ann_texts):
            offs[i] = acc
            pool.extend(texts)
            acc += len(texts)
        offs[n] = acc

        if sys.byteorder != 'little':
            for a in (start, end, inst, cls, offs):
                a.byteswap()
        return {
            'count': n,
            'start': start.tobytes(),
            'end': end.tobytes(),
            'inst': inst.tobytes(),
            'cls': cls.tobytes(),
            'textOffset': offs.tobytes(),
            'texts': pool,
        }


def probe_all(dec_ids):
    """Import every decoder and report which ones load unmodified.

    This is the "how many stock decoders run" number - it is an honest
    import + metadata check, not a claim that every one of them decodes
    correctly on arbitrary input.
    """
    ok, bad = [], {}
    for d in sorted(dec_ids):
        try:
            describe(d)
            ok.append(d)
        except Exception as e:
            bad[d] = '%s: %s' % (type(e).__name__, e)
    return {'ok': ok, 'failed': bad}
