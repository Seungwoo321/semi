# AGENTS.md

This file provides guidance to coding agents when working with code in this repository.

## What This Is

Semi is a local Slack scheduling service for coding-agent sessions.

## Runtime

Node.js 24+, Slack Bolt with Socket Mode, built-in SQLite. Each user runs their own
Slack app on their Mac. Keep tokens, app bindings, schedules, and run files out of Git.
Terminal delivery must preserve the selected session identity and must not retry an
ambiguous delivery. A report and its thread replies belong to the original session.

## Before you finish

Run `pnpm run lint` and `pnpm test` after source changes.

## Code Style

- No code comments. Make the code explain itself with clear names, tests, or types. Put the reason for a change in the PR description.
