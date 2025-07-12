# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Run Commands
- Build: `npm run build`
- Start: `npm start`
- Development: `npm run dev` (watch mode)
- Run with tracing: `export ANTHROPIC_API_KEY="sk-ant-******" && npm run build && npm start`

## Code Style Guidelines
- Use ES modules (import/export)
- Target ES2022
- Maintain strict TypeScript typing
- Use async/await for asynchronous operations
- Follow existing error handling patterns with try/catch blocks
- Propagate trace context through `_meta.__traceContext` property
- Use camelCase for variables and functions, PascalCase for classes
- When creating spans, include relevant attributes for observability
- Properly end spans in finally blocks
- Use Promise-based APIs consistently
- Instrument with OpenTelemetry for distributed tracing