# Shared Browser display controls

This follow-up builds on the input core. It adds toolbar menus, Fit and Actual
size, grouped resolutions, favorites, independent mobile emulation and capture
density. It keeps medium JPEG quality and the original 800 KB frame bound.
Larger captures can reduce JPEG quality to fit that bound.

Transport caching, transport defaults and an agent device tool remain separate
from these human display controls. Linux private display support follows in its
own change with an explicit opt-out.
