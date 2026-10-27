Agent monitor is one roster of every agent on a host, so you can see which ones need you without walking the workspace tree. It adds an **Agent monitor** sidebar screen and a Command Center item. Agents are grouped by project and workspace and sorted into Attention, Running, Idle and Closed, where Attention covers agents that need input, have errored, or have a pending permission request. The sidebar row also shows a count of agents needing attention.

Settings control grouping, sort order, density, which details each row shows, and the default filter. They are stored per host and shared by every connected client.

The header switches between the **Roster** and a **Graph** view. The graph groups agents into compact project/workspace panels, adds provider-native subagents as dashed nodes, and draws parent, message and subagent edges with thickness scaled by message count. Cards can be dragged, the canvas panned and zoomed, and the graph filtered by project, workspace, provider, subagents or connected-only. Selecting a card or an edge focuses its neighbourhood and dims the rest.

It reads agent, workspace and project lists through the selected host's existing connection and opens no connection of its own. While the graph is open, it also reads up to 200 timeline entries from each of up to 60 agents, prioritizing open and recently updated agents, four at a time. Readable timelines, including closed agents, contribute message and subagent information. The one lifecycle action it performs is archiving, either a single agent or all closed agents. It cannot interrupt a running turn.

Requires Paseo ^0.13.0 || ^0.14.0.
