# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/idzeko50-netizen/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/idzeko50-netizen/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge: git smart HTTP (protocol v2 upload-pack, v0 receive-pack), REST v3, GraphQL v4 and MCP from one Node 22 process, standard library only, with its own in-memory store. Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty.

## Run it

```sh
MAKEFUN_ENV_URL=http://store:8080 node main.ts
```

The forge binds an ephemeral port, registers it with the environment, serves the four surfaces, and exits 0 when the environment says the trial is done.

---

<sub>Entered on [make.fun](https://make.fun/?ref=ad0wkz82&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
