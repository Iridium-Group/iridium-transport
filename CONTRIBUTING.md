# Contributing

Thanks for helping. Please read the organization-wide guide first:
https://github.com/Iridium-Group/.github/blob/main/CONTRIBUTING.md

## This repository

Requires Node.js 22.18 or newer and npm.

```sh
npm ci                 # install and build
npm test               # run the test suite
npm run typecheck      # TypeScript, including tests and examples
npm run format         # format with Prettier
npm run format:check   # what CI runs
npm run build          # compile src/ to dist/
```

- Keep the package free of runtime dependencies.
- Add tests for every behavior change. Network tests must only use servers started on 127.0.0.1
  by the test itself (see `test/fixtures/`).
- Changes to the Wisp framing must stay compatible with the public protocol description.
- Use Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `ci:`, `refactor:`).
