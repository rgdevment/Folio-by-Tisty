# Folio by Tisty privacy policy

**Version 5, in force since November 9, 2026.**

## The short version

Folio keeps the least it needs to work, and nearly all of it is encrypted
with a key it never receives. No accounts, no cookies, no analytics, no ads,
and nothing from third parties on the page. What it keeps expires on its own,
except your key's public part and the keys you took back; the operator deletes
their mail by hand. This policy says exactly what it keeps, why, and for how
long.

Who answers for this data: Mario Hidalgo G., a natural person in Chile, who
runs Folio as a non-profit. Contact: <rgdevment@tisty.app>.

## What it cannot see

- **What you share.** The text, the pictures, the attached files and the inner
  signature are encrypted in your Tisty before they leave. The key travels in
  the link, after the `#`, and browsers do not send it to the server.
- **Who you are.** There are no accounts, no email addresses and no names.

## What it does keep, and for how long

| What | Why | For how long |
|---|---|---|
| The encrypted document and its attached files, with its latest version and those replaced in the last 3 days | To serve it to whoever has the link, and so a report can reach what someone replaced | Until the time without activity you choose, 15 days at most, or until you stop sharing it. If you pause it, it is not served and stays up to 30 days unless you resume it. If a report of deceit or a grave one holds it, the operator blocks it or an order holds it, it is not served once it expires, you stop sharing it or it is blocked, and it stays with its other languages for up to 180 days from the last report or the block, or for as long as an order or an authority asks. During a spending block or a failure, what was replaced can take longer to be deleted |
| The manifest in the clear: how many parts, what each weighs, their kind and the version | To hold the limits without reading the content | As long as the document |
| The manage link, kept as a digest (hash), and the public key of the edit link's token, which never reaches the server | To check who may change or delete it | As long as the document |
| Your public key and its certificate, in what you share, with the exact time each version arrived | So readers know it is yours and since when | As long as the document |
| Your public key on its own, the day Folio first saw it, which version of the terms it accepted and in what hour the server heard it, and whether the operator blocked it, tied to no network and no document | So limits and reputation stay with it, and a new key starts from the lowest | For good, even after your documents are gone |
| How many times it was read, counted once a day per visitor, and in which hours on a day with 5 or more | To show you the reads in Tisty | As long as the document |
| A line for each read served: the link's id (without its key, so it opens nothing), the country and the Cloudflare data center, never your IP | To know how much each document is read and where from, and size the service | Up to 7 days, in Cloudflare's Workers Logs |
| A digest of your IP (an HMAC with a key that changes), also beside the document you uploaded that day | Per-IP limits and blocks against abuse, and so the operator sees when one network makes many keys or documents | As long as the quota or the block lasts, and up to a day more |
| For each document and day: how many networks read it, how many with a proof of work, in how many hours and how many in its busiest hour, and whether the only one was the network that uploaded it, never which | So the operator can tell a group of readers from a farm of bots, or a document only its owner keeps alive | 31 days, or less if the document goes first |
| A daily copy of the database, encrypted with a key kept offline, without the day's read digests, the quotas or the network that uploaded each document, and without the documents | To recover from a failure | 30 days, on GitHub. While it is there anyone with a GitHub account can download it, always encrypted with a post-quantum key kept offline |
| What the operator did to a document or a key and why, opening it included: its id, the action and the reason | To answer for it later | 180 days, or while an order holds the document |
| A case link, to verify a report or to hand to an authority: a digest of its token, the document and version it opens, each opening and, when it is for an authority, the document's records, encrypted with a key Folio does not keep and without the network or the email of whoever reported | So whoever verifies or investigates can read that version even once the document is blocked | 30 days; the openings, as above |
| A summary by mail to the operator, up to four times a day: the id of the links reported, blocked or appealed, the category and how many networks reported, never a key, an IP or the content | To tell them what to review | Up to 180 days, or more if an order asks, in their Migadu mailbox |
| What you write to the operator by mail, with your address | To answer you | Up to 180 days from the last message, or more if an order asks, in their Migadu mailbox |
| Keys you took back, up to 64, as your root signed them: the key's public part and your root's | So readers learn that a stolen or retired key no longer speaks for you | For good, since a reader must always be able to tell |
| Reports: category, detail and the version reported, in the clear; the link and an email if given, sealed so only the operator can open them; and a digest of the reporter's network (an HMAC with a key that changes every 180 days), so each network reports only once, with the number of its provider (ASN), so a block needs reports from different providers | To moderate and pass them where they belong | 180 days, or longer if an order or an authority asks for it. If the operator finds it false, that network's digest stays, with the day and hour it was first found false, for up to 180 days from the last time it was, so it stops counting |

**About signing:** your public key lets anyone tell that two documents come from
the same person, though not who you are. The exception is the operator's key,
which signs as rgdevment: its public part and that name are published in
Folio's limits, and what it signs may be shown as «verified».

**About reads:** they are counted without keeping who read. Not to count the
same person twice on one day, a short-lived digest is used, which notes whether
it came with a proof of work and is thrown away when the day ends. Its key
changes every day and is kept only for that day, outside the database and the
backups.

**About what is deleted:** the database keeps its own copy for up to 30 days at
Cloudflare, to recover from a failure. Whatever is deleted from it, such as the
read and network digests, an email or a key you asked to erase, or a document's
record, stays there until then. The documents do not: they are deleted at once.

## Whose, from where and on what basis

It keeps data about four groups of people: those who share from Tisty, those
who open a link, those who report and those who write to the operator. All of it
comes from you, from your Tisty or your browser, or from your connection, which
is where Cloudflare takes the country and the data center from. A report brings
what its reporter wrote about a document. Nothing comes from public sources.

- **Sharing and serving what is shared** is what you ask for when you accept the
  [terms](TERMS.md).
- **The limits, the network digests, the reports, the logs and the backups**
  serve the legitimate interest of keeping the service safe, within its cost and
  free of abuse. That interest never needs to know who you are.
- **What an authority asks for** is kept or handed over under a legal duty.
- **The email you leave in a report** is the only thing that rests on your
  consent. You may take it back whenever you want by asking for it to be erased,
  and that does not undo what was already done with it.

## Cloudflare and other providers

Folio runs on Cloudflare (Workers, D1 and R2). Cloudflare receives your
IP and your requests when you connect, as any web server does, and handles them
under its own [privacy policy](https://www.cloudflare.com/privacypolicy/). It
never receives the key after the `#`, so it cannot read what you share either.

The home of tisty.cl, and the page it shows for a link that is gone, only
explain what Folio is. They are fixed files: they keep nothing about you, on the
server or in your browser. Cloudflare also receives your IP and your requests
when you visit them. On the page that reads a link, if you choose the light or
dark mode, your browser remembers that choice; it never leaves your device.

Three others take part, each with a policy of its own:

- **[Migadu](https://www.migadu.com/privacy/)** carries and keeps the operator's
  mail, with what the table above says.
- **[GitHub](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)**
  keeps the copies of the database, encrypted with a key it does not have.
  Tisty also asks it for the limits, the terms and the domain its links live
  on, so GitHub receives the IP of whoever is about to share.
- **[Healthchecks.io](https://healthchecks.io/privacy/)** gets a signal when each
  scheduled task ends, to warn if one stops arriving. It carries nobody's data.

These providers operate outside Chile, so what they receive leaves the country:
Cloudflare and GitHub from the United States, Migadu from Switzerland and
Healthchecks.io from Latvia, in the European Union. Chile's Personal Data
Protection Agency has not yet declared which countries offer an adequate level
of protection. Until it does, the safeguards are each provider's policy, linked
above, and that what is shared reaches them encrypted.

When the operator reports phishing or malware, Google Safe Browsing (United
States) and Cloudflare receive the address of the deceiving site, never a
document's key. What looks like a crime goes to the PDI or the prosecutor.

## The promise of encryption, said honestly

- **Between two Tisty**, nobody else can read what is shared: not the operator,
  not Cloudflare, not whoever steals the database.
- **In a browser**, the code that decrypts is served by the same server. That
  protects against a leak or an order over what is stored, but not against an
  operator who chose to change that code to steal keys. The code is public so
  anyone can check it.
- **A report with the link to read it** makes that document readable. It is
  done only in the cases the [terms](TERMS.md) list, and every opening is logged.

## What is decided on its own

Some rules act without anyone looking, always on a key, a network or a document,
never on a person anyone knows:

- **A new key** starts with the lowest limits for its first 30 days, and each
  network brings only a few new keys a day.
- **A network past its share** waits, and past a certain number of readers the
  browser does a small piece of computing work before reading.
- **Reports** can ask whoever shared for a new version, or block a document,
  when they come from several networks of different providers.

The [terms](TERMS.md) give each threshold and how to appeal. The operator can
review and undo what these rules did.

## Security

What the design protects and how to report a flaw is in the
[security policy](SECURITY.md). If a flaw exposes personal data, the operator
tells Chile's Personal Data Protection Agency and, where the law asks, each
person affected.

## Your rights

Under Chilean Law 21.719 you may ask what data about you there is, have it
corrected or deleted, object to its use, take it with you, or have it blocked
while another request is settled. The operator answers within 30 calendar days.
What you shared is already in your Tisty, in its own format, and Folio keeps no
other copy it can read. Since there are no accounts, the most direct ways are:

- **Delete what you shared:** with your management link, or by no longer
  sharing it from Tisty. It stops being served at once and is deleted from the
  server at the next cleanup, normally within an hour; during a spending block or
  a failure it can take longer. A serious report or an order can require keeping
  it.
- **The email you left in a report:** write to <abuso@tisty.app> with the
  document's id and the operator erases it. It stays in the encrypted backups for
  up to 30 days.
- **Anything else:** write to <rgdevment@tisty.app>. The digest of your IP does
  not say who you are, but given your IP the operator can find what is kept
  under it while its key lasts: a day for quotas and reads, and up to 180 days
  for reports.
- **Your public key:** only you can show it is yours, so sign the request with
  it. It leaves the list of keys and starts over as a new one, with its
  reputation gone and no mark left. It stays for as long as these last: in the
  documents you still share and the versions you signed, in a key you took back,
  in what a report keeps for up to 180 days, in the operator's log for up to 180
  days, and in the backups for 30 days. A key the operator blocked stays blocked.

If the operator does not answer in time or turns your request down, you may
complain to Chile's Personal Data Protection Agency.

## Children

Folio is not meant for children under 14.

## Changes

Every change to this policy is committed to the public repository, with its
date. If the two versions differ, the Spanish one governs.

[Español](PRIVACIDAD.md)
