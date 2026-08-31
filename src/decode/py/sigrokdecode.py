# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Daniel Tralamazza
##
## Pure-Python re-implementation of the `sigrokdecode` module that
## libsigrokdecode's C core exposes to protocol decoders.
##
## Stock sigrok decoders `import sigrokdecode as srd` and subclass
## `srd.Decoder`. The C core implements put()/register()/wait()/has_channel()
## as C methods on that base class and drives each decoder's decode() on its
## own thread, blocking inside wait() until the frontend feeds more samples.
##
## We cannot block a Pyodide thread, so this module inverts the model: the
## whole sample range is present up front, and wait() searches it directly.
## The observable semantics are kept bit-identical to instance.c/type_decoder.c
## (see WAIT SEMANTICS below), which is what makes stock decoders run
## unmodified.
##
## WAIT SEMANTICS (transcribed from libsigrokdecode instance.c find_match()):
##   * The scan starts *at* self.samplenum, not after it. On a match the
##     cursor is NOT advanced, so the next wait() re-examines the same sample.
##   * `old_pins` is updated for every sample the scan examines. At the first
##     examined sample old == new, so an edge term can never match there.
##     For every later sample old == sample[s-1].
##   * An empty condition therefore has to skip 1 (skip 0 only at samplenum 0
##     on the very first wait()), which is what set_skip_condition() does.
##   * Conditions are OR-ed (list of dicts), terms inside a dict are AND-ed,
##     and `self.matched` reports, per condition, whether it held at the
##     sample that matched.
##   * Terms inside a dict are evaluated in insertion order with early-out,
##     which matters only for 'skip' terms sharing a dict with channel terms
##     (no stock decoder does that; handled by a slow exact path anyway).
##   * Running off the end of the sample data raises EOFError, mirroring
##     libsigrokdecode's communicate_eof path.
##

from bisect import bisect_left, bisect_right

# enum srd_output_type, libsigrokdecode.h
OUTPUT_ANN = 0
OUTPUT_PYTHON = 1
OUTPUT_BINARY = 2
OUTPUT_LOGIC = 3
OUTPUT_META = 4

# enum srd_configkey
SRD_CONF_SAMPLERATE = 10000

# Sentinel used by decoders that set self.initial_pins.
SRD_INITIAL_PIN_LOW = 0
SRD_INITIAL_PIN_HIGH = 1
SRD_INITIAL_PIN_SAME_AS_SAMPLE0 = 2

__version__ = '0.6.0-logicweb'


class Signal:
    """One channel, stored as its edge positions.

    `edges` is the sorted list of sample indices s where sample[s] !=
    sample[s-1] (so never 0). `initial` is the level at sample 0. This is
    exactly what SampleStore.edges() hands us, and it makes every condition
    term an O(log n) lookup instead of an O(samples) scan.
    """

    __slots__ = ('edges', 'initial', 'length')

    def __init__(self, edges, initial, length):
        self.edges = edges
        self.initial = initial
        self.length = length

    def level_at(self, s):
        return self.initial ^ (bisect_right(self.edges, s) & 1)

    def next_level(self, s, want):
        """Smallest t >= s with level(t) == want, or -1."""
        if self.initial ^ (bisect_right(self.edges, s) & 1) == want:
            return s
        i = bisect_right(self.edges, s)
        if i >= len(self.edges):
            return -1
        return self.edges[i]

    def next_edge(self, s):
        """Smallest edge position e >= s, or -1."""
        i = bisect_left(self.edges, s)
        if i >= len(self.edges):
            return -1
        return self.edges[i]

    def next_edge_to(self, s, want):
        """Smallest edge position e >= s whose new level is `want`, or -1.

        Edges alternate, so level(edges[i]) == initial ^ ((i+1) & 1); the
        parity of i is fixed by `want` and no scanning is needed.
        """
        i = bisect_left(self.edges, s)
        # want == initial ^ ((i+1) & 1)  =>  (i+1)&1 == want^initial
        if (i + 1) & 1 != (want ^ self.initial):
            i += 1
        if i >= len(self.edges):
            return -1
        return self.edges[i]

    def next_non_edge(self, s, start_scan):
        """Smallest t >= s that is not an edge (old == new), or -1.

        The first examined sample always counts as "no edge" because old is
        seeded from that very sample.
        """
        if s <= start_scan:
            return start_scan
        i = bisect_left(self.edges, s)
        while i < len(self.edges) and self.edges[i] == s:
            s += 1
            i += 1
        return s if s < self.length else -1


# Term type codes, mirroring enum in libsigrokdecode-internal.h.
_T_HIGH, _T_LOW, _T_RISE, _T_FALL, _T_EITHER, _T_NOEDGE, _T_SKIP, _T_FALSE = range(8)

_TERM_FROM_CHAR = {
    'h': _T_HIGH, 'l': _T_LOW, 'r': _T_RISE,
    'f': _T_FALL, 'e': _T_EITHER, 'n': _T_NOEDGE,
}


class _Term:
    __slots__ = ('type', 'channel', 'skip')

    def __init__(self, type_, channel=-1, skip=0):
        self.type = type_
        self.channel = channel
        self.skip = skip


class SrdError(Exception):
    pass


class Terminate(BaseException):
    """Emulates libsigrokdecode killing the decode thread at end of data.

    sigrok-cli 0.7.2 / libsigrokdecode 0.5.3 does not deliver EOFError to
    decode(): it terminates the worker thread from inside wait(), so anything a
    decoder does after catching EOFError never runs natively. Deriving from
    BaseException means this passes straight through the decoders' own
    `except EOFError` and `except Exception` handlers, exactly as a killed
    thread would. Selected with srdengine.Session(eof_mode='terminate'); the
    default is to deliver EOFError, which is what upstream libsigrokdecode does
    when the frontend signals EOF and which keeps the last item of a capture.
    """


class _Inst:
    """Per-instance state that the C core keeps in struct srd_decoder_inst."""

    __slots__ = ('inst_id', 'signals', 'channelmap', 'num_channels', 'length',
                 'cur', 'have_cond_list', 'outputs', 'next_di', 'ann_sink',
                 'py_sink', 'bin_sink', 'decoder_id', 'stopped',
                 'py_inst', 'stacked', 'inst_index', 'eof_mode')

    def __init__(self):
        self.eof_mode = 'raise'
        self.py_inst = None
        self.stacked = False
        self.inst_index = 0
        self.inst_id = ''
        self.decoder_id = ''
        self.signals = []       # index = capture channel
        self.channelmap = []    # index = decoder channel -> capture channel or -1
        self.num_channels = 0
        self.length = 0
        self.cur = 0
        self.have_cond_list = False
        self.outputs = []       # pdo_id -> (output_type, proto_id)
        self.next_di = []       # instances stacked on top of this one
        self.ann_sink = None
        self.py_sink = None
        self.bin_sink = None
        self.stopped = False


class Decoder:
    """Base class for all sigrok protocol decoders."""

    def __init__(self, *args, **kwargs):
        # The C core attaches the instance struct after construction; a
        # decoder that touches _srd before that is a bug we want to see.
        self._srd = None

    # -- output registration -------------------------------------------------

    def register(self, output_type, proto_id=None, meta=None):
        srd = self._srd
        if proto_id is None:
            proto_id = srd.inst_id
        for i, (t, p) in enumerate(srd.outputs):
            if t == output_type and p == proto_id:
                return i
        srd.outputs.append((output_type, proto_id))
        return len(srd.outputs) - 1

    # -- output emission -----------------------------------------------------

    def put(self, startsample, endsample, output_id, data):
        srd = self._srd
        try:
            otype, _proto = srd.outputs[output_id]
        except IndexError:
            raise SrdError('Invalid output ID %s' % output_id)

        if otype == OUTPUT_ANN:
            if srd.ann_sink is not None:
                srd.ann_sink(srd, startsample, endsample, data)
        elif otype == OUTPUT_PYTHON:
            # Stacked decoders are driven synchronously, exactly like
            # Decoder_put()'s SRD_OUTPUT_PYTHON branch.
            for nxt in srd.next_di:
                nxt.py_inst.decode(startsample, endsample, data)
            if srd.py_sink is not None:
                srd.py_sink(srd, startsample, endsample, data)
        elif otype == OUTPUT_BINARY:
            if srd.bin_sink is not None:
                srd.bin_sink(srd, startsample, endsample, data)
        elif otype in (OUTPUT_META, OUTPUT_LOGIC):
            pass  # Not surfaced by the UI yet; silently accepted as in srd.
        else:
            raise SrdError('Unknown output type %s' % otype)

    def has_channel(self, idx):
        srd = self._srd
        if idx < 0 or idx >= srd.num_channels:
            raise IndexError('invalid channel index')
        return srd.channelmap[idx] != -1

    # -- condition matching --------------------------------------------------

    def _parse_conds(self, args):
        """Turn wait()'s argument into a list of term lists.

        Returns (cond_terms, is_empty) where is_empty reproduces
        set_new_condition_list()'s "9999" path: None, [] or {} only.
        `wait([{}])` is *not* that path - it is an automatic match that
        returns the current sample again with self.matched == None.
        """
        if not args:
            return [], True
        spec = args[0]
        if spec is None:
            return [], True
        if isinstance(spec, dict):
            if len(spec) == 0:
                return [], True
            spec = [spec]
        elif isinstance(spec, (list, tuple)):
            if len(spec) == 0:
                return [], True
        else:
            raise TypeError('Condition list is neither a list nor a dict')

        srd = self._srd
        conds = []
        for d in spec:
            if not isinstance(d, dict):
                raise TypeError('Condition is not a dict')
            if len(d) == 0:
                conds.append(None)
                continue
            terms = []
            for key, val in d.items():
                if isinstance(key, bool):
                    raise TypeError('Term key is neither a string nor a number')
                if isinstance(key, int):
                    t = _TERM_FROM_CHAR.get(str(val)[0:1], -1)
                    if t < 0:
                        raise SrdError('Unknown term "%s"' % (val,))
                    if key < 0 or key >= srd.num_channels:
                        t = _T_FALSE
                    elif srd.channelmap[key] == -1:
                        # Unused optional channel: nothing can ever match.
                        t = _T_FALSE
                    terms.append(_Term(t, channel=key))
                elif isinstance(key, str):
                    n = int(val)
                    terms.append(_Term(_T_FALSE if n < 0 else _T_SKIP, skip=n))
                else:
                    raise TypeError('Term key is neither a string nor a number')
            conds.append(terms)
        return conds, False

    def _cond_first_match(self, terms, start):
        """Smallest sample >= start at which every term in `terms` holds.

        Returns -1 if the condition cannot match before the end of data.
        """
        srd = self._srd
        if terms is None:
            return -1
        if not terms:
            return -1

        n_skip = sum(1 for t in terms if t.type == _T_SKIP)
        if n_skip and len(terms) > 1:
            return self._cond_first_match_slow(terms, start)

        pos = start
        # Monotone fixpoint: each term pushes the candidate forward until all
        # of them agree on the same sample.
        while True:
            moved = False
            for t in terms:
                tt = t.type
                if tt == _T_FALSE:
                    return -1
                if tt == _T_SKIP:
                    nxt = start + t.skip
                elif tt == _T_HIGH:
                    nxt = srd.signals[srd.channelmap[t.channel]].next_level(pos, 1)
                elif tt == _T_LOW:
                    nxt = srd.signals[srd.channelmap[t.channel]].next_level(pos, 0)
                else:
                    sig = srd.signals[srd.channelmap[t.channel]]
                    # Edges can never match at the first examined sample.
                    epos = pos if pos > start else start + 1
                    if tt == _T_RISE:
                        nxt = sig.next_edge_to(epos, 1)
                    elif tt == _T_FALL:
                        nxt = sig.next_edge_to(epos, 0)
                    elif tt == _T_EITHER:
                        nxt = sig.next_edge(epos)
                    else:  # _T_NOEDGE
                        nxt = sig.next_non_edge(pos, start)
                if nxt < 0:
                    return -1
                if nxt > pos:
                    pos = nxt
                    moved = True
            if not moved:
                return pos if pos < srd.length else -1

    def _cond_first_match_slow(self, terms, start):
        """Exact per-sample evaluation, used only for dicts that mix 'skip'
        with channel terms. all_terms_match() short-circuits, so a skip
        counter only advances on samples where every preceding term held."""
        srd = self._srd
        skipped = [0] * len(terms)
        s = start
        length = srd.length
        while s < length:
            ok = True
            for i, t in enumerate(terms):
                tt = t.type
                if tt == _T_FALSE:
                    return -1
                if tt == _T_SKIP:
                    if skipped[i] == t.skip:
                        continue
                    skipped[i] += 1
                    ok = False
                    break
                sig = srd.signals[srd.channelmap[t.channel]]
                new = sig.level_at(s)
                old = new if s == start else sig.level_at(s - 1)
                if tt == _T_HIGH:
                    hit = new == 1
                elif tt == _T_LOW:
                    hit = new == 0
                elif tt == _T_RISE:
                    hit = old == 0 and new == 1
                elif tt == _T_FALL:
                    hit = old == 1 and new == 0
                elif tt == _T_EITHER:
                    hit = old != new
                else:
                    hit = old == new
                if not hit:
                    ok = False
                    break
            if ok:
                return s
            s += 1
        return -1

    def _eof(self):
        if self._srd.eof_mode == 'terminate':
            return Terminate('sample data exhausted')
        return EOFError('sample data exhausted')

    def wait(self, *args):
        srd = self._srd
        if srd.stopped:
            raise self._eof()

        conds, is_empty = self._parse_conds(args)

        if is_empty:
            # set_skip_condition(): skip 1 unless we are still at sample 0
            # and no condition list has ever been installed.
            if srd.cur:
                skip = 1
            elif not srd.have_cond_list:
                skip = 0
            else:
                skip = 1
            conds = [[_Term(_T_SKIP, skip=skip)]]
        srd.have_cond_list = True

        start = srd.cur

        # have_non_null_conds(): a list made only of empty dicts is an
        # automatic match at the current sample, with matched == None.
        if all(c is None for c in conds):
            self.samplenum = start
            self.matched = None
            cm, sigs = srd.channelmap, srd.signals
            return tuple(0xff if cm[i] == -1 else sigs[cm[i]].level_at(start)
                         for i in range(srd.num_channels))

        firsts = [self._cond_first_match(c, start) for c in conds]
        best = -1
        for f in firsts:
            if f >= 0 and (best < 0 or f < best):
                best = f

        if best < 0:
            srd.cur = srd.length
            self.samplenum = srd.length
            srd.stopped = True
            raise self._eof()

        srd.cur = best
        self.samplenum = best
        self.matched = tuple(f == best for f in firsts)

        cm = srd.channelmap
        sigs = srd.signals
        return tuple(0xff if cm[i] == -1 else sigs[cm[i]].level_at(best)
                     for i in range(srd.num_channels))
