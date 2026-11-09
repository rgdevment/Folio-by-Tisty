# Contributing to Folio by Tisty

Folio by Tisty is the service behind Tisty's shared links at tisty.cl,
whose site is [www.tisty.app](https://www.tisty.app): the server and the page
that reads a link. The Tisty app lives in [its own
repository](https://github.com/rgdevment/Tisty), with its own guide.

Bug reports, feature discussions and pull requests are all welcome. Everyone
taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you write code

**Open an issue first for anything beyond a bug fix.** The service keeps
promises about what it stores, for how long and who can read it, written in its
[terms](docs/TERMS.md), [privacy policy](docs/PRIVACY.md) and
[security policy](docs/SECURITY.md). A change that touches any of them needs
those documents changed with it, in both languages, and an agreement first.
Asking first costs nothing.

**Never test against someone else's link,** and never with load meant to bring
the service down. A vulnerability goes to [SECURITY.md](docs/SECURITY.md), not
to an issue.

## The CLA

Folio by Tisty is released under the [FSL-1.1-ALv2](LICENSE), and each version
can also be used under the Apache License 2.0 two years after it is published.
Every contributor signs a one-time [CLA](CLA.md) before their code can be
merged. Publishing your code that way, or under another licence later on,
requires the right to do so, and that right has to come from each author
explicitly.

**You keep the copyright on your work.** The CLA is a licence you grant, not a
transfer of ownership.

The first time you open a Pull Request, a bot asks you to sign. Reply on that
Pull Request with exactly:

```text
I have read the CLA Document and I hereby sign the CLA
```

That is it — every later Pull Request from the same account is covered, and so
is anything you sent before signing. A signature for Tisty does not cover this
repository: it keeps its own record.

**Code in an issue or in a review suggestion counts too.** The bot only watches
Pull Requests, so those routes reach the codebase without passing it. If you
have not signed, keep such snippets to a description of the fix rather than the
patch itself, and a maintainer will write it.

**In return, the project commits that:**

- The code stays public, and every version opens as its licence says.
- Your contribution is never removed from the public code to make it exclusive
  to a paid edition.
- Your authorship is preserved; history is not rewritten to erase it.
- No release already published is ever retroactively withdrawn.

If you would rather not sign, you can still use the service, report bugs,
request features, discuss design, and fork the project under its licence. Only
merging code into this repository requires the agreement.

## Development setup

The service is written in TypeScript and runs on Cloudflare Workers. Its API is
in [docs/openapi.yaml](docs/openapi.yaml). The earlier code, in Rust, stays in
the `chore/rust-service-backup` branch of
[the archived repository](https://github.com/rgdevment/Folio-by-Tisty-aglp).
Node 22 is all it asks for:

```sh
git clone https://github.com/rgdevment/Folio-by-Tisty.git
npm ci
npm run limits
```

`npm run limits` copies the signed limits from their own branch into
`.limits/`, which git does not keep. The build and the tests read them there.

Before opening a pull request, run what CI runs:

```sh
npm run lint:md
npm run typecheck
npm run lint
npm run build
npm run budget
npm test
```

`npm run dev` shows the page with a sample document.

## House style

**Code, identifiers, comments, test names and error messages are in English.**
Conversations and issues can be in Spanish or English.

**Comments default to none.** Write one only for a non-obvious *why* that would
surprise a future reader: a hidden constraint, a workaround, a subtle
invariant. Never to narrate what the code already says, and never to record
history — that is what the commit log is for.

**The documents travel in pairs.** `README.md` and `README.es.md`, and in
`docs/` the terms, the privacy policy and the security policy, say the same in
English and Spanish, with the same headings, tables and code blocks.

**The Worker's migrations only add.** A rollback puts back code that reads the
tables as they were, so a migration never drops or renames anything. Secrets go
up with `wrangler secret put` and never into the tree.

## Commits

A commit is one line in English, `type(scope): change`, where the type is one
of `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`,
`chore` or `revert`, and the scope, when it helps, names the part it touches:
`fix(server):`, `feat(web):`, `docs:`. Nothing goes under it — no body, no
trailers, no co-authors or sign-offs. The *why* belongs in the pull request; the
*what* is already in the patch. Keep it to 112 characters at most: CI refuses a
longer one, and a commit with lines under it.

Pull requests are squashed, and the squash keeps the pull request's title, so
that title — with the number GitHub adds after it, `(#123)` — is the subject
that reaches `main`, and CI holds it to the same shape, 120 characters with the
number.

A branch says the same thing before its first commit: `kind/what`, in lowercase,
where the kind is one of the types above or `hotfix` or `release`, as in
`feat/expiry-notice` or `fix/reader-cap`. `scripts/branches.sh` holds that
shape.

`scripts/rules.sh` holds the conventions a person can break in a second: the
English and Spanish documents drifting apart in shape, and a token in the tree.
`scripts/commits.sh` holds the shape and the length of a subject, and that
nothing sits under it. Run either whenever you like. They
also run for you: `npm install` or `npm ci` at the root points git at the hooks
unless git already has a hooks path of yours, and `--ignore-scripts` skips it.
Without npm it is one line:

```sh
git config core.hooksPath hooks
```

That gives you three. `pre-commit` runs the conventions and the branch's name
over what is staged, not over the working tree beside it — a few seconds, and
between them they are most of what turns CI red.
`commit-msg` weighs the subject while the fix is still an `--amend` rather than
a rebase. `pre-push` runs the conventions again, the name each branch takes on
the remote and the subjects of everything you are about to send. Nothing slower
goes in any of them: the markdown lint and the rest belong to CI.

**Those hooks are comfort, not enforcement.** A fresh clone does not have them
until `npm install` runs or somebody sets that, and `--no-verify` walks straight
past all three. What the repository actually requires is what CI refuses, which
is why the workflows run the same two files rather than keeping their own copies
of the rules.

## Security

Do not open a public issue for a vulnerability. See
[docs/SECURITY.md](docs/SECURITY.md).
