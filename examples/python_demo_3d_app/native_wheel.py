"""Preserve Windows wheel deltas before Panda3D converts them to buttons."""
import ctypes
from collections import deque
from ctypes import wintypes


class NativeWheel:
    def __init__(self, window):
        self.pending = deque()
        self.hwnd = window.get_window_handle().get_int_handle()
        self.api = ctypes.WinDLL('comctl32', use_last_error=True)
        pointer = ctypes.c_size_t
        result = ctypes.c_ssize_t
        callback_type = ctypes.WINFUNCTYPE(result, wintypes.HWND, wintypes.UINT,
                                          wintypes.WPARAM, wintypes.LPARAM, pointer, pointer)
        self.api.SetWindowSubclass.argtypes = [wintypes.HWND, callback_type, pointer, pointer]
        self.api.SetWindowSubclass.restype = wintypes.BOOL
        self.api.RemoveWindowSubclass.argtypes = [wintypes.HWND, callback_type, pointer]
        self.api.RemoveWindowSubclass.restype = wintypes.BOOL
        self.api.DefSubclassProc.argtypes = [wintypes.HWND, wintypes.UINT,
                                           wintypes.WPARAM, wintypes.LPARAM]
        self.api.DefSubclassProc.restype = result
        self.callback = callback_type(self._message)  # Keep alive until detached.
        self.identifier = id(self)
        if not self.api.SetWindowSubclass(self.hwnd,self.callback,self.identifier,0):
            raise OSError('Unable to install native wheel handler')

    def _message(self, hwnd, message, wparam, lparam, identifier, reference):
        if message == 0x020A:  # WM_MOUSEWHEEL; 120 units = one wheel detent.
            self.pending.append(ctypes.c_short((wparam >> 16) & 0xffff).value / 120.0)
            return 0  # Do not also generate Panda's quantized wheel buttons.
        if message == 0x0082:  # WM_NCDESTROY
            self.close()
        return self.api.DefSubclassProc(hwnd,message,wparam,lparam)

    def drain(self):
        while self.pending:
            yield self.pending.popleft()

    def close(self):
        if self.hwnd is not None:
            if not self.api.RemoveWindowSubclass(self.hwnd,self.callback,self.identifier):
                raise OSError('Unable to remove native wheel handler')
            self.hwnd = None
        self.pending.clear()
