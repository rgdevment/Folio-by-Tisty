# Folio by Tisty privacy policy

**Draft of November 5, 2026.** Folio is not open yet.

## The short version

Folio keeps the least it needs to work, and nearly all of it is encrypted
with a key it never receives. No accounts, no cookies, no analytics, no ads,
and nothing from third parties on the page. What it keeps expires on its own.
This policy says exactly what it keeps, why, and for how long.

Who answers for this data: Mario, a natural person in Chile, who runs Folio
as a non-profit. Contact: <rgdevment@tisty.app>.

## What it cannot see

- **What you share.** The text, the pictures, the attached files and the inner
  signature are encrypted in your Tisty before they leave. The key travels in
  the link, after the `#`, and browsers do not send it to the server.
- **Who you are.** There are no accounts, no email addresses and no names.

## What it does keep, and for how long

| What | Why | For how long |
|---|---|---|
| The encrypted document and its attached files, with its last 3 versions and those replaced in the last 7 days | To serve it to whoever has the link, and so a report can reach what someone replaced | Until the time without activity you choose, 15 days at most, or until you stop sharing it. With a serious report or an order, it is no longer served and stays for up to 180 days, or for as long as the order asks |
| The manifest in the clear: how many parts, what each weighs, their kind and the version | To hold the limits without reading the content | As long as the document |
| The manage link, kept as a digest (hash), and the public key of the edit link's token, which never reaches the server | To check who may change or delete it | As long as the document |
| If you sign, your public key and its certificate | So readers know it is yours | As long as the document |
| How many times it was read, counted once a day per visitor | To show you the reads in Tisty | As long as the document |
| A line for each read served: the link's id (without its key, so it opens nothing), the country and the Cloudflare data center, never your IP | To know how much each document is read and where from, and size the service | 3 days, in Cloudflare's Workers Logs |
| A digest of your IP (an HMAC with a key that changes) | Per-IP limits and blocks against abuse | As long as the quota or the block lasts |
| A daily copy of the database, encrypted with a key kept offline, without the day's read digests or quotas, and without the documents | To recover from a failure | 30 days, on GitHub |
| Keys you took back, as your root signed them: the key's public part and your root's | So readers learn that a stolen or retired key no longer speaks for you | For good, since a reader must always be able to tell |
| Reports: category, detail, the version reported, the link if given, sealed so only the operator can open it, and a digest of the reporter's network (an HMAC with a key that changes every 180 days), so each network reports only once | To moderate and pass them where they belong | 180 days, or longer if an order asks for it. If an appeal against a report is accepted, that network's digest stays 180 days from then, so it stops counting |

**About signing:** if you sign what you share, your public key lets anyone tell
that two signed documents come from the same person, though not who you are.
That is why signing is optional for unlisted documents.

**About reads:** they are counted without keeping who read. Not to count the
same person twice on one day, a short-lived digest is used and thrown away when
the day ends. Its key changes every day and is not kept. The database keeps its
own copy for up to 30 days, to recover from a failure, and the digest stays
there until then; it never goes into the backups.

## Cloudflare

Folio runs on Cloudflare (Workers, D1 and R2). Cloudflare receives your
IP and your requests when you connect, as any web server does, and handles them
under its own [privacy policy](https://www.cloudflare.com/privacypolicy/). It
never receives the key after the `#`, so it cannot read what you share either.

## The promise of encryption, said honestly

- **Between two Tisty**, nobody else can read what is shared: not the operator,
  not Cloudflare, not whoever steals the database.
- **In a browser**, the code that decrypts is served by the same server. That
  protects against a leak or an order over what is stored, but not against an
  operator who chose to change that code to steal keys. The code is public so
  anyone can check it.
- **A report with the link to read it** makes that document readable. It is
  done only in the cases the [terms](TERMS.md) list, and every opening is logged.

## Your rights

Under Chilean Law 21.719 you may ask what data about you there is, have it
corrected or deleted, or object to its use. Since there are no accounts, the
most direct ways are:

- **Delete what you shared:** with your management link, or by no longer
  sharing it from Tisty. It is deleted from the server at once.
- **Anything else:** write to <rgdevment@tisty.app>. The digest of your IP does
  not reveal who you are, so in general there is no data that can be tied to
  you.

## Children

Folio is not meant for children under 14.

## Changes

Every change to this policy is committed to the public repository, with its
date.

[Español](PRIVACIDAD.md)
