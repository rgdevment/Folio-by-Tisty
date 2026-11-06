# Folio by Tisty privacy policy

**Draft of November 6, 2026.** Folio is not open yet.

## The short version

Folio keeps the least it needs to work, and nearly all of it is encrypted
with a key it never receives. No accounts, no cookies, no analytics, no ads,
and nothing from third parties on the page. What it keeps expires on its own,
except your key's public part and the keys you took back; the operator deletes
their mail by hand. This policy says exactly what it keeps, why, and for how
long.

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
| Your public key and its certificate, in what you share | So readers know it is yours | As long as the document |
| Your public key on its own, and the day Folio first saw it, tied to no network and no document | So limits and reputation stay with it, and a new key starts from the lowest | For good, even after your documents are gone |
| How many times it was read, counted once a day per visitor | To show you the reads in Tisty | As long as the document |
| A line for each read served: the link's id (without its key, so it opens nothing), the country and the Cloudflare data center, never your IP | To know how much each document is read and where from, and size the service | Up to 7 days, in Cloudflare's Workers Logs |
| A digest of your IP (an HMAC with a key that changes) | Per-IP limits and blocks against abuse | As long as the quota or the block lasts, and up to a day more |
| A daily copy of the database, encrypted with a key kept offline, without the day's read digests or quotas, and without the documents | To recover from a failure | 30 days, on GitHub |
| What the operator did to a document and why, opening it included: its id, the action and the reason | To answer for it later | 180 days |
| A summary by mail to the operator, up to twice a day: the id of the links reported, blocked or appealed, the category and how many networks reported, never a key, an IP or the content | To tell them what to review | Up to 180 days, or more if an order asks, in their Migadu mailbox |
| What you write to the operator by mail, with your address | To answer you | Up to 180 days from the last message, or more if an order asks, in their Migadu mailbox |
| Keys you took back, as your root signed them: the key's public part and your root's | So readers learn that a stolen or retired key no longer speaks for you | For good, since a reader must always be able to tell |
| Reports: category, detail and the version reported, in the clear; the link if given, sealed so only the operator can open it; and a digest of the reporter's network (an HMAC with a key that changes every 180 days), so each network reports only once | To moderate and pass them where they belong | 180 days, or longer if an order asks for it. If an appeal against a report is accepted, that network's digest stays 180 days from then, so it stops counting |

**About signing:** your public key lets anyone tell that two documents come from
the same person, though not who you are.

**About reads:** they are counted without keeping who read. Not to count the
same person twice on one day, a short-lived digest is used and thrown away when
the day ends. Its key changes every day and is not kept. The database keeps its
own copy for up to 30 days, to recover from a failure, and the digest stays
there until then; it never goes into the backups.

## Cloudflare and other providers

Folio runs on Cloudflare (Workers, D1 and R2). Cloudflare receives your
IP and your requests when you connect, as any web server does, and handles them
under its own [privacy policy](https://www.cloudflare.com/privacypolicy/). It
never receives the key after the `#`, so it cannot read what you share either.

The page at `folio.tisty.app` only explains what Folio is. It is fixed files: it
keeps nothing about you, on the server or in your browser. Cloudflare also
receives your IP and your requests when you visit it.

Three others take part, each with a policy of its own:

- **[Migadu](https://www.migadu.com/privacy/)** carries and keeps the operator's
  mail, with what the table above says.
- **[GitHub](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)**
  keeps the copies of the database, encrypted with a key it does not have.
  Tisty also asks it for the limits and the terms before sharing, so GitHub
  receives the IP of whoever is about to share.
- **[Healthchecks.io](https://healthchecks.io/privacy/)** gets a signal when each
  scheduled task ends, to warn if one stops arriving. It carries nobody's data.

These providers operate outside Chile, so what they receive leaves the country.

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
  sharing it from Tisty. It stops being served at once and is deleted from the
  server at the next cleanup, normally within an hour; during a spending block or
  a failure it can take longer. A serious report or an order can require keeping
  it.
- **Anything else:** write to <rgdevment@tisty.app>. The digest of your IP does
  not reveal who you are, so in general there is no data that can be tied to
  you.
- **Your public key:** only you can show it is yours, so sign the request with
  it. It leaves the list of keys and starts over as a new one, with its
  reputation gone and no mark left. It stays for as long as these last: in the
  documents you still share and the versions you signed, in a key you took back,
  in what a report keeps for up to 180 days, and in the backups for 30 days.

## Children

Folio is not meant for children under 14.

## Changes

Every change to this policy is committed to the public repository, with its
date.

[Español](PRIVACIDAD.md)
