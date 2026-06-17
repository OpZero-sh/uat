# UAT Engine Roadmap

**Role:** uat is the platform's **verification layer** — an AI-native test engine exposed over MCP. It gives an agent a browser (Playwright), an HTTP client, and an MCP probe, plus a declarative YAML flow runner and a scenario lifecycle (evidence, expected-vs-actual, human sign-off, release blocking). Today it verifies *targets* — the OpZero site, its API, and MCP servers — driven by flow specs rather than by anything it knows about the agent that produced the work. The org's north star is to turn that into uniform verification of **agent sessions themselves** (Claude Code, Codex, …) by consuming the unified session event/transcript schema, then feeding results into platform observability/audit.

See the [OpZero platform roadmap](https://github.com/OpZero-sh/.github/blob/main/ROADMAP.md) for org-wide vision and phases.

> Status legend: ✅ shipped · 🟡 in progress · ⚪ planned
> Last verified against the code: **2026-06-17**

---

## Where this repo is today

The engine itself is **mature for target verification**: 46 MCP tools across 9 categories (session/navigate/interact/observe/assert/api/mcp-client/flow/record), a YAML flow runner with interpolation/conditionals/parallel/cross-step data, a scenario layer with sign-off and release-blocking, visual diffing (pixelmatch), and production hardening (multi-stage Docker, non-root, graceful drain, readiness probe). What it has **not** yet done is plug into the org's *agent-session* schema — verification is target-driven, with no notion of "which agent/session produced this."

---

## Near-term

- ✅ MCP-native test engine — browser + API + MCP-probe tools, streamable HTTP on `:3200` (Phase-agnostic foundation).
- ✅ Declarative flow runner + scenario lifecycle (evidence, expected/actual, `record_signoff`, release blocking).
- ✅ Production-hardened container (Docker, Railway config, graceful shutdown, health/readiness).
- 🟡 Verify OpZero targets in practice — flows exist for site/API/MCP, but they're examples; real suites against `opzero.sh` + `/mcp` are still being filled in (**Phase 3** deploy-verify).
- ⚪ **Consume the unified agent session event/transcript schema (Phase 4)** — define how a session feed maps onto scenarios so verification keys off session events, not just target URLs. *No session-schema code exists in the repo yet.*
- ⚪ Make verification **agent-agnostic** — same scenario passes/fails uniformly whether the work came from a Claude Code or a Codex session (**Phase 4**).

## Later

- ⚪ **Feed Phase 5 observability/audit** — emit scenario results, evidence, and sign-off events into the platform audit log alongside orchestrate + deploy actions.
- ⚪ Authenticate through **MCPAuthKit** so uat runs under the same per-user token family as the hub and deploy MCP (Phase 1/2).
- ⚪ Pair with **token-5-0** on the shared session schema (uat for verification, token-5-0 for context vaulting) so both consume one event format.
- ⚪ Wire into the unified `code.opzero.sh/mcp` connector so verification is callable from the same authenticated surface as build + deploy (Phase 3).

---

*This is a per-repo view; the canonical phases and cross-repo workstreams live in the [org roadmap](https://github.com/OpZero-sh/.github/blob/main/ROADMAP.md).*
