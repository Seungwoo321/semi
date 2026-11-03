<p align="center"><img src="assets/logo.png" width="360" alt="Semi"></p>

# Semi

[한국어 사용 가이드](docs/guide.ko.md) · [pnpm installation](https://pnpm.io/installation)

Schedule your local coding agents from Slack. Run configurable prompts or skills in **Orca or cmux**, collect **Codex or Claude Code** results in selected channels, and talk to them through your personal bot's DM or a report thread.

Semi is self-hosted: **each user installs their own Slack app and runs Semi on their Mac**. Installing the Slack app alone does not run the scheduler. There is no central service or separate LLM API subscription; your existing coding-agent session performs the work with its own authentication and permissions.

## How it works

```text
Slack command / thread reply
          ↕ Socket Mode
Semi on your Mac → selected Orca / cmux sessions
          ↑                ↓
          └──── agent result command
```

- A schedule has a name, interval in minutes, prompt, and one or more sessions.
- Choose sessions across both terminal applications and both coding agents.
- Reports default to your bot DM. A session destination overrides the schedule destination, which overrides the bot default.
- The default bot name is `<Slack username>-semi`; change it during setup or with `/semi name`.
- Separate personal/work profiles have distinct apps, credentials, schedules, messages, and login services. A session can belong to only one profile.
- Reply in a report's thread to request follow-up work from that exact session. Follow-up results return to the same thread.
- Only the configured Slack owner can manage schedules or send follow-up requests.
- The Mac and Semi must be running. Slack's desktop app does not need to be open; phone and browser clients work too.

## Requirements

- macOS and Node.js **24 or later**.
- pnpm **12.15.0** (pinned in `package.json`).
- [Slack CLI](https://docs.slack.dev/tools/slack-cli/) authenticated with `slack login`.
- Orca and/or cmux with their CLI available and agent status hooks enabled.
- An existing local Codex or Claude Code terminal session. Remote sessions and Orca's structured chat surfaces are not terminal targets.

## Install your Slack app

```sh
git clone https://github.com/Seungwoo321/semi.git
cd semi
pnpm install --frozen-lockfile
slack login
slack app install --team YOUR_WORKSPACE_ID --environment deployed
pnpm run setup --app YOUR_APP_ID --team YOUR_WORKSPACE_ID --owner YOUR_USER_ID
```

`slack auth list` shows your workspace and user IDs. Use the app ID printed by the install command. `setup` derives `<Slack username>-semi` by default; append `--name "My Semi"` to choose another name. App names and installation IDs are stored privately per profile, while the repository manifest stays generic.

For an existing app, use `slack app link` first. Do not combine an explicit `--app` with `--environment`. The standard `personal` profile is used when `SEMI_PROFILE` is unset.

In your app settings, finish the runtime credentials:

1. **OAuth & Permissions**: copy the **Bot User OAuth Token**.
2. **Basic Information → App-Level Tokens**: generate a token with **connections:write**.
3. Put them in `.local/profiles/personal/.env` (create the directory if needed):

```dotenv
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
```

```sh
chmod 600 .local/profiles/personal/.env
pnpm start
```

Tokens are read from the local file and never embedded in the login service or stored in Git. The app connects through Socket Mode. Production installations run with `pnpm start`; `slack run` is the separate development workflow for an app installed with `--environment local`.

Add the bot to every destination channel using Slack's **Add apps** action. App installation belongs to a workspace, not to a single channel. Private destination channels must explicitly include the bot.

## Manage schedules in Slack

| Command                 | Action                                                   |
| ----------------------- | -------------------------------------------------------- |
| `/semi target`          | Choose the session for new DM messages                   |
| `/semi name NAME`       | Change this profile's Slack bot name                     |
| `/semi new`             | Open the schedule form                                   |
| `/semi list`            | Show schedule IDs and status                             |
| `/semi edit ID`         | Change sessions, interval, prompt, and channels          |
| `/semi pause ID`        | Pause a schedule                                         |
| `/semi resume ID`       | Resume, with the next run one interval later             |
| `/semi delete ID`       | Delete a schedule and cancel its unsent requests         |
| `/semi status ID`       | Inspect up to 50 recent session runs                     |
| `/semi default-channel` | Use the current channel as the bot default               |
| `/semi resolve RUN_ID`  | Release an unresolved request after checking its outcome |

The creation form lists available sessions with their terminal application and coding agent. Select multiple sessions, enter an interval such as **30 minutes**, and write the work to perform. Examples:

- `Report completed work, current work, blockers, and the next step.`
- `Check the latest test results and explain failures without changing code.`
- Invoke an installed skill using the syntax supported by the selected coding agent.

The next form sets optional channel overrides per session. A schedule starts after its configured interval. Saving edits resets the next run and cancels older requests that have not been sent. It does not cancel work already delivered to an agent.

## Direct messages and thread replies

Open a DM with your bot and send a request. The first request offers a session picker and is kept until you select a session. `/semi target` changes the target for new DM messages. Replies to existing report threads always retain their original target.


A report records its original session and destination. Reply to that message in a Slack thread; Semi queues the reply for the same session and posts a short receipt. It does not route by the currently focused terminal or by channel name. Messages from other users, bot messages, and unlinked channel conversations are ignored.

The source session must still exist. Semi does not silently create a replacement or change an agent's approval settings. An agent can report that it cannot perform a request.

## Run in the background

After `pnpm start` connects successfully, stop that foreground process with Ctrl+C and install the login service:

```sh
pnpm run service install
pnpm run service status
```

The macOS LaunchAgent starts Semi at login and restarts it after a failure. Keep the checkout at the same path. Reinstall the service after changing Node or checkout locations or selecting a different Slack app. Logs are `.local/profiles/personal/service.log` and `.local/profiles/personal/service-error.log`.

```sh
pnpm run service uninstall
```

Uninstalling the service retains schedules and local configuration. No inbound network port, public server, or router configuration is required.

## Personal and work accounts

Log in to each Slack workspace with `slack login`. Authenticate in the appropriate Slack workspace; the existing login is retained. Enterprise Grid organization authorization does not by itself select an installation workspace. Company policies may require app approval.

Use an explicit profile for each separate Slack installation:

```sh
SEMI_PROFILE=work slack app install --team WORK_WORKSPACE_ID --environment deployed
SEMI_PROFILE=work pnpm run setup --app WORK_APP_ID --team WORK_WORKSPACE_ID --owner WORK_USER_ID
```

Place that app's tokens in `.local/profiles/work/.env`, then run:

```sh
SEMI_PROFILE=work pnpm start
SEMI_PROFILE=work pnpm run service install
SEMI_PROFILE=work pnpm run service status
```

Stop the foreground instance before installing its service. The personal and work services can run simultaneously. Each accepts only its configured workspace and owner. Sessions assigned to one profile are excluded from the other profile's selectors, including replies. Use separate agent sessions for personal and company work.

## Delivery and recovery

- The scheduler checks due work every 10 seconds. A busy agent waits until its status indicates idle. A requested interval is not a guarantee that an LLM finishes at that time.
- After sleep or downtime, missed occurrences of the same schedule/session are coalesced into one request.
- A pending or unresolved request prevents another occurrence for the same schedule/session. Different schedules and replies for one session are serialized.
- Orca provides an input receipt; cmux input acceptance alone does not prove a model turn began. A successfully posted report is the completion receipt.
- A transport failure after input or posting may have succeeded remotely. Semi marks it `uncertain` and does not retry automatically. Inspect the terminal and Slack before using `resolve`.
- Pausing/deleting a schedule cannot retract input already sent. Resolving a run cannot cancel work already running.
- Closed, replaced, or remote sessions fail validation. Select the replacement explicitly in the schedule editor.
- For cmux, resume metadata must identify the selected session and status hooks must report idle. If it stays waiting, check those hooks and any open permission prompt.
- A report is plain text, up to 4000 characters including the session heading. Links/media are not automatically unfurled.

SQLite state, pending task files, and logs live under `.local/profiles/<profile>/`; the session ownership registry is `.local/session-owners.sqlite`. These files use local file permissions and are excluded from Git. Task files contain user prompts; treat that directory as private. Copy the entire directory only while Semi is stopped if you need a backup.

## Terminal diagnostics and message delivery

```sh
node cli.js targets orca
node cli.js targets cmux
node cli.js status
node cli.js status SCHEDULE_ID
node cli.js send CHANNEL_ID <<'MESSAGE'
A message sent using the installed bot identity.
MESSAGE
```

Scheduled tasks give the agent a run-specific `node cli.js report RUN_ID` command. That command selects the recorded channel and thread, and prevents duplicate reporting. It does not require the agent to guess a channel or use the Slack connector signed in as a person.

## Development

```sh
pnpm test
pnpm run lint
```

Tests cover fan-out, DM/channel routing, waiting and ambiguous sends, restart recovery, thread mapping, duplicate replies, stale sessions, bot identity, owner authorization, and profile separation. No separate build or typechecker is configured. The project uses Slack's Bolt blank template and retains its MIT notice.

## Assets

- [`assets/icon.png`](assets/icon.png): Slack app icon.
- [`assets/logo.png`](assets/logo.png): transparent logo lockup.
- [`assets/social-preview.png`](assets/social-preview.png): repository/social banner.

License: [MIT](LICENSE).
