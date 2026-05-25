# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues in `ariesfish/pi-goal`. Use the `gh` CLI for all operations.

This workspace may be a source checkout without a `.git` directory. When `gh` cannot infer the repository from `git remote -v`, pass the repo explicitly with `-R ariesfish/pi-goal`.

## Conventions

- **Create an issue**: `gh issue create -R ariesfish/pi-goal --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view -R ariesfish/pi-goal <number> --comments`, filtering comments by `jq` and also fetching labels when needed.
- **List issues**: `gh issue list -R ariesfish/pi-goal --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment -R ariesfish/pi-goal <number> --body "..."`
- **Apply / remove labels**: `gh issue edit -R ariesfish/pi-goal <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close -R ariesfish/pi-goal <number> --comment "..."`

If running inside a normal Git clone with the GitHub remote configured, omitting `-R ariesfish/pi-goal` is acceptable.

## When a skill says "publish to the issue tracker"

Create a GitHub issue in `ariesfish/pi-goal`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view -R ariesfish/pi-goal <number> --comments`.
