Generate a clean system architecture diagram for an AI-powered full-stack development agent. Use a top-to-bottom layered layout with clear boxes and directional arrows. The diagram should use a professional color palette (dark blue for core components, teal for tools/skills, gray for external dependencies, and orange for the sandbox target project).

## Layers (top to bottom):

### Layer 1: User / Browser
- A box labeled "Browser" with sub-text "React Web Console"
- Features inside: Session List, Chat Panel, Streaming Output, Preview Panel, Element Annotation, Memory Manager, Skill Manager

### Layer 2: Server API (HTTP + SSE)
- A box labeled "Server (Node.js HTTP)"
- Sub-components: Session API, SSE Stream Proxy, Preview Proxy, File Browser, Metrics

### Layer 3: Orchestrator
- A box labeled "Orchestrator"
- Sub-text: State Management, Memory Recall, Context Compression, Confirm Flow (read/write)

### Layer 4: Agent Core Loop
- A box labeled "Agent Core Loop"
- Sub-text: System Prompt, Tool Selection, Skill Loading, Result Parsing, Max 30 Iterations

### Layer 5: Two parallel subsystems

**Left side — Skills & Tools:**
- "Skill Registry" box containing 6 skills: requirement-analysis, solution-design, code-generation, pull-request, repository-tools, auto-memory
- "Tool Registry" box containing 12 tools split into 3 groups:
  - Read (6): readTextFile, listDirectory, searchFiles, searchContent, verifyCode, compressContext
  - Write (5): writeFile, deleteFile, createPullRequest, forkRepository, cloneRepository  
  - Memory (1): writeMemory
- Arrows from Agent Core to both Skill and Tool registries

**Right side — LLM Layer:**
- "QueryEngine" box with sub-text: Stream Processing, Retry Logic (exponential backoff), Token Counting
- "LLM Client" box below it containing: OpenAI-compatible adapter, Anthropic adapter, Monitored Client (metrics wrapper)
- Arrow from QueryEngine to LLM Client
- Arrow from LLM Client to "External LLM API" box (gray)

### Layer 6: Sandbox Target Project
- A prominent orange/brown box labeled "Sandbox Repo (Target Project)"
- Sub-text: Git Operations (via git.ts/gh.ts), File Read/Write, Verify Code (tsc/lint/build/test), API Contract Check
- Arrows from Tool Registry pointing to this box
- Two-way arrow between Sandbox and LLM (Agent reads code → generates changes)

## Connections (arrows):
1. Browser → Server: "HTTP + SSE Stream" (bidirectional)
2. Server → Orchestrator: "Session & State"
3. Orchestrator → Agent Core Loop: "User Input + Context"
4. Agent Core Loop → Skill Registry: "use_skill()"
5. Agent Core Loop → Tool Registry: "executeTool()"
6. Agent Core Loop → QueryEngine: "streamChat()"
7. QueryEngine → LLM Client → External LLM API
8. Tool Registry → Sandbox Repo: "read/write/verify/git"
9. Sandbox Repo → Agent Core Loop: "tool results (file content, errors, etc.)"

## Style:
- Clean modern tech diagram style with rounded rectangles
- White background
- Use connector lines with arrowheads (not just straight lines)
- Label each arrow and layer clearly
- Add a legend in the bottom-right corner showing the color scheme
- Overall aspect ratio: 16:9 or vertical layout suitable for a presentation slide
