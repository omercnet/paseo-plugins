# OMP bucket list: research summary

Snapshot taken before the decisions, kept as written. 53 items researched, one decision question each. Notes per item in `items/item-NN.md`; final answers in `DECISIONS.md`; what shipped in `README.md`.

## Recommended to build (works with Paseo's built-in omp provider)

| Item | What | Size | Question |
|---|---|---|---|
| 11 | Spending cap: warn and max budget fields in the Configuration tab | S | Q16 |
| 35 | Tool policy card: per-tool allow/ask/deny, bash command rules, restricted folders | M | Q34 |
| 54 | "Update available" line and Update button in Diagnostics | S | Q6 |
| 31 | models.yml error check in Diagnostics, plus a Refresh models action | S | Q57 |
| 30 | Add/remove marketplace catalogs in the OMP plugins tab | S-M | Q39 |
| 40 | Regroup optional-tool switches in the Configuration tab | S | Q10 |
| 25 | One Diagnostics warning: APPEND_SYSTEM.md silently overridden; SYSTEM.md drops tool policy | S | Q21 |
| 16 | One Help-tab line for /share, /dump, /fresh (they already work by typing) | S | Q35 |
| 22a-e | Rules tab (decided, build pending) | M | Q3, Q4 answered |

## Later (fold into other work)

| Item | When | Question |
|---|---|---|
| 21 Skills, 27 learned skills, 28 extensions, 29 commands, 26 sources, 24 context files | As sections or source labels in the Rules tab family | Q36, Q38, Q42, Q41, Q33, Q20 |
| 36 model presets, 39 list settings | Next time the routing/settings editor is touched | Q13, Q51 |
| 06 export HTML | Once a way to deliver a daemon-side file to remote clients exists | Q26 |
| 13 branch tree | Branch-summary row now; tree after upstream RPC | Q5 |
| 18 context notes, 47 LSP card, 49 image previews, 51 usage tab | Revisit on demand | Q8, Q14, Q22, Q9 |

## Gaps

Everything that would need a change in Paseo or OMP is listed in `GAPS.md`:

1. **No live OMP commands from the built-in omp provider.** Items 03 queued messages, 04 goal, 05 side questions, 07 titles, 08 fork, 09 retries, 10 usage-limit banner, 12 todos, 14 composer shell, 15 process reuse.
2. **Rich tool results reduced to text.** Items 44 eval, 45 browser screenshots (a regression versus our own provider), 49 images, 43 CI card.
3. **OMP doesn't report enough.** Items 31, 22, 21, 28, 41.
4. **Paseo client features plugins can't add.** Items 50, 49, 06.

## Findings worth acting on regardless

- **Deprecation blocker:** the built-in omp provider drops `eval` images, so browser screenshots that our provider shows today disappear (item 45).
- **Bug:** Paseo's `--append-system-prompt` replaces a user's `APPEND_SYSTEM.md` instead of adding to it (item 25).
- **Misleading setting:** `tools.approvalMode` in our settings editor has no effect on Paseo agents; Paseo's launch flag overrides it (item 35).
- **Layering trap:** project-level OMP list settings replace user-level ones (item 21); applies to the Rules on/off switch (22b) and any list editor (39).
- **Fallback visibility:** agents can silently fall back to another model (seen during this research with a broken fallback model); item 38 option C would surface it.
- **Plugins can send messages to agents** (`paseo.agents.ref(id).send`, used by the MCP popover), so "button that runs a slash command" ideas are feasible.
