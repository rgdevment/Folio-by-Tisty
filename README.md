# Folio by Tisty

[Español](README.es.md)

Folio by Tisty turns a Tisty document into a link anyone can read: anonymous,
end-to-end encrypted, and gone on its own after a while. It is a **service**,
separate from the Tisty app, with its own server, rules and promises. Its links
live at tisty.cl, and its site is [www.tisty.app](https://www.tisty.app).

> **It does not promise what the app promises.** The Tisty app has no server
> and collects nothing. Folio does run a server: it keeps encrypted copies
> until they expire, counts reads and keeps a few anonymous records. What it
> keeps, why and for how long is in its [privacy policy](docs/PRIVACY.md).

## How it works

- **You share from Tisty,** from the *Shared* row of a document's panel, since
  version 1.42.0. While Folio is not open yet, Tisty says so and uploads
  nothing. Nothing is shared any other way, and there are no accounts: the link
  is the permission.
- **Each document gets three links:** one to read, one to edit and one to
  manage.
- **What you share is encrypted in your Tisty before it leaves.** The key
  travels in the link, after the `#`, which browsers never send. The server
  keeps bytes it cannot read.
- **Every version is signed** with your machine's key, so a reader can tell it
  came from you.
- **It expires on its own** after the time without activity you choose, from one
  day to 15 at most. Your document stays in your Tisty.
- **A lost link cannot be recovered,** because the server never had its key.
  While the document is shared, Tisty keeps its links: copy them again from its
  *Shared* row. Once it expires or you stop sharing it, share it again for new
  ones.
- **A link opens in any browser,** at tisty.cl, and is edited in another Tisty
  with *Edit in Tisty*.

How the encryption and the signatures work, and what they do not protect, is in
the [security policy](docs/SECURITY.md).

## Its documents

| | |
|---|---|
| [Terms of use](docs/TERMS.md) | What is allowed, reports and removal, warranty and liability |
| [Privacy policy](docs/PRIVACY.md) | What the service keeps, why, for how long, and your rights |
| [Security policy](docs/SECURITY.md) | How to report a vulnerability, and what the design protects and does not |

## Who runs it

Mario, a natural person in Chile, as a non-profit project whose code is public.
There is no company behind it and nobody makes money from it. Contact:
<rgdevment@tisty.app>.

## Its code

It is being written again from scratch in TypeScript, on Cloudflare Workers, D1
and R2, and the service is not open yet: [folio.tisty.app](https://folio.tisty.app)
says what it is. It speaks to the
[Tisty app](https://github.com/rgdevment/Tisty) through a contract that the
app's repository keeps: the formats of what travels and the style rules of a
page. The earlier code, in Rust, stays in the `chore/rust-service-backup`
branch of [the archived repository](https://github.com/rgdevment/Folio-by-Tisty-aglp).

## Licence

Folio is under the [Functional Source License 1.1, Apache 2.0 Future
License](LICENSE) (FSL-1.1-ALv2).

- **Free for anyone:** read it, audit it, use it, change it and share it, at
  home or at work.
- **Not allowed:** offering it to others in a commercial product or service that
  competes with Folio.
- **When a version opens:** two years after it is published, that version can
  also be used under the Apache License 2.0, with no limit on competing.

The contract with Tisty is included under
[an additional permission](https://github.com/rgdevment/Tisty/blob/main/contracts/ADDITIONAL-PERMISSION.md),
as it is published and without changes. Anywhere else, or changed, it stays under
the AGPL-3.0.

This licence gives no right to the names or marks of Folio and Tisty. The
drawings of the mark and the mascot, `src/page/public/icon.svg` and
`src/page/public/tisto.svg`, are not part of it.

What came before this repository, up to commit `dad2c24`, stays under the
AGPL-3.0 in [its archive](https://github.com/rgdevment/Folio-by-Tisty-aglp).
