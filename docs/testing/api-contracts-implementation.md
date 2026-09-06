# API contract AST checker implementation

## Result

Task 5 replaces the previous regular-expression extraction with a bounded, non-executing TypeScript compiler-API analysis in `src/tools/apiContracts.ts`. The verifier reports call coverage plus matched, unmatched, and unresolved evidence with relative file names and source lines. Its heading no longer describes an all-skipped run or contract warnings as a clean verification pass, and identifies contract analysis as a static aid rather than an integration test.

## Supported forms

- Axios default-import aliases, `axios.get/post/put/delete/patch/...`, config-object calls, and `axios.create({ baseURL })` instances.
- Literal and relative URLs, bounded identifier/property lookup, string concatenation, template placeholders, and conditional static method sets.
- Express apps and routers created through `express.Router()` or imported `Router` aliases.
- Router mounts composed recursively across local variables, ES default imports, and CommonJS `require()` modules.
- Express `:parameter` and client template placeholders normalize for matching. Static wildcard fallback routes are excluded.
- Unsupported dynamic URLs, methods, route paths, mount prefixes, and unmounted routers remain explicit `unresolved` results.

## Test evidence

- `node --import tsx --test tests/api-contracts.test.ts`: 9 passed, 0 failed. Regression coverage includes cyclic mounts, retained Fetch calls, Axios/Fetch GET defaults, callable instances, absolute and unresolved dynamic base URLs, ambiguous cross-scope constants, Router variables exported through ESM default or CommonJS `module.exports`, correlated method/URL conditionals, and query/fragment-insensitive route matching.
- `npm run build`: passed.
- Read-only analysis of `D:/project/Agent_test_project/conduit-realworld-example-app`: 17 statically resolved Axios/Fetch calls, 20 composed routes, all 17 calls matched, 3 routes had no discovered client call, and 1 dynamic call remained unresolved. Known mappings include login, favorite/unfavorite, and the correlated create/update article branches.

## Limitations

The evaluator intentionally does not execute code or perform full TypeScript symbol/type resolution. Computed imports, named re-export chains, spread-heavy configuration objects, arbitrary functions, complex URL builders, Axios aliases created by arbitrary assignment, and runtime-generated router mounts are reported unresolved or may remain outside the extracted set. Constant lookup is bounded and file-local rather than lexically scope-aware; a repeated identifier anywhere in one file is conservatively removed from constant evaluation, making dependent calls unresolved instead of risking a cross-scope false match. Identical conditional expressions on Axios method and URL are paired branch-for-branch; distinct dual conditionals remain unresolved because their combinations cannot be proven. Router cycles are detected and reported rather than recursively expanded. Query strings and fragments are removed for route comparison. The checker measures statically discovered client-call coverage only and is not proof that endpoints work at runtime.
