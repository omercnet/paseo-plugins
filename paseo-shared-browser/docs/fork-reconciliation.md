# Upstream review sequence

The interaction PR carries natural mouse, touch and keyboard input plus viewer-expiry recovery.
Display controls follow separately, then optional Xvfb with an environment opt-out.
Transport defaults, caching, the agent device tool and encoded video are coordinated in #275.

The streaming branch merges those prerequisite branches while preserving its existing
video, Android presentation and human-input work. No changes to the Paseo app are included here.

The upstream 0.9/0.10/0.11 manifest ranges remain, with the tested 0.11.0-beta.3 allowance.
Older runtime combinations and wide/compact visual acceptance still need qualification.
