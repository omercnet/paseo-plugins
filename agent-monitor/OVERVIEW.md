Agent monitor is one roster of every agent on a host, so you can see which ones need you without walking the workspace tree. It adds an **Agent monitor** sidebar screen and a Command Center item. Agents are grouped by project and workspace and sorted into Attention, Running, Idle and Closed, where Attention covers agents that need input, have errored, or have a pending permission request. On Paseo 0.11 the sidebar row also shows a count of agents needing attention.

Settings control grouping, sort order, density, which details each row shows, and the default filter. They are stored per host and shared by every connected client.

It reads agent, workspace and project lists through the selected host's existing connection and opens no connection of its own. The one action it performs is archiving, either a single agent or all closed agents. It cannot interrupt a running turn.

Requires Paseo ^0.9.0, ^0.10.0 or ^0.11.0. Paseo 0.9 and 0.10 get the sidebar item without the count.
