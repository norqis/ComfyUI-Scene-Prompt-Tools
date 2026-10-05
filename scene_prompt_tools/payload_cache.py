"""LRU payload storage bounded by entry count and retained Python objects."""

import sys
from collections import OrderedDict


def retained_size(value):
    """Count each object once, without recursion or serializing large payloads."""
    pending = [value]
    seen = set()
    size = 0
    while pending:
        item = pending.pop()
        identity = id(item)
        if identity in seen:
            continue
        seen.add(identity)
        size += sys.getsizeof(item)
        if isinstance(item, dict):
            pending.extend(item.keys())
            pending.extend(item.values())
        elif isinstance(item, (list, tuple, set, frozenset)):
            pending.extend(item)
    return size


class PayloadCache(OrderedDict):
    """Callers own locking; measure outside their lock and pass put() its weight."""

    def __init__(self, max_entries, max_bytes):
        super().__init__()
        self.max_entries = max_entries
        self.max_bytes = max_bytes
        self.retained_bytes = 0
        self._weights = {}

    def weight(self, key):
        return self._weights[key]

    def put(self, key, value, weight):
        self.pop(key, None)
        if weight > self.max_bytes:
            return False
        super().__setitem__(key, value)
        self._weights[key] = weight
        self.retained_bytes += weight
        while len(self) > self.max_entries or self.retained_bytes > self.max_bytes:
            self.popitem(last=False)
        return True

    def __setitem__(self, key, value):
        self.put(key, value, retained_size((key, value)))

    def __delitem__(self, key):
        super().__delitem__(key)
        self.retained_bytes -= self._weights.pop(key)

    def pop(self, key, *default):
        if key not in self:
            if default:
                return default[0]
            raise KeyError(key)
        value = self[key]
        del self[key]
        return value

    def popitem(self, last=True):
        key, value = super().popitem(last=last)
        self.retained_bytes -= self._weights.pop(key)
        return key, value

    def clear(self):
        super().clear()
        self._weights.clear()
        self.retained_bytes = 0
