# Folio by Tisty terms of use

**Draft of November 6, 2026.** Folio is not open yet.

## The short version

Folio turns a Tisty document into a link you can share. There are no
accounts: the link is the permission. What you share is encrypted, and the
service stores it without the key to read it. It is free, non-profit and comes
with no warranty: it may fail, change or end. Your document always stays in
your Tisty; the link is a copy that expires.

## Who runs it

Folio is run by Mario, a natural person in Chile, as a non-profit project.
There is no company behind it and nobody makes money from it. The service's
code is public, under the
[Functional Source License 1.1, Apache 2.0 Future License](../LICENSE).

## What Folio is

Folio is a service apart from the Tisty app. Tisty writes, signs and encrypts;
Folio keeps what arrives and hands it to whoever has the link. Folio only
receives and shows: documents are edited in Tisty, never here.

## What they cover

The service that stores and serves shared documents, at
tisty.cl, and the page where they are read in a browser.
The Tisty app has [terms of its own](https://github.com/rgdevment/Tisty/blob/main/TERMS.md).

## How it works

- **You share only from Tisty**, and what you share is unlisted: whoever has the
  link reads it.
- **Each document has three links:** one to read, one to edit and one to
  manage. Whoever holds a link holds that power; keep them like a key.
- **What you share is end-to-end encrypted.** The key travels in the link,
  after the `#`, and never reaches the server. The server keeps bytes it
  cannot read.
- **What you share expires on its own** after the time without activity you
  choose when sharing, from one day to 15 days at most: no reads, no visits of
  yours and no new versions. When it expires, the links
  stop working and the server's copy is deleted. Your document stays in Tisty,
  and you can share it again. With a serious report or an order, it is no longer
  served, but its copy stays for up to 180 days, or for as long as the order asks.
- **There are limits** on size and on how many pictures and files a document carries,
  which the service may change. Tisty tells you before sharing if something
  does not fit.

## Your key and your reputation

- **You accept these terms** the first time you share from Tisty, and Tisty
  explains the basics then.
- **Your key is how Folio tells you apart.** Tisty signs what you share with a
  key of yours, and Folio keeps its public part for good, even after your
  documents are gone. It does not say who you are. The name you choose to show
  travels encrypted, and only those with the link read it.
- **Your reputation belongs to that key.** Limits start low, and reputation is
  what will open more. How it is earned is not decided yet, and these terms will
  say so when it is. Reports alone never take it away: only what the operator
  confirms counts.
- **A new key starts from the lowest limits,** and each network can bring only a
  few new ones a day.

## What is not allowed

Even though nobody can read what is encrypted, sharing it is still your
responsibility. You may not use Folio for:

- Child sexual abuse material, in any form.
- Sexually explicit images of anyone.
- Intimate images of someone without their consent.
- Phishing, malware, scams or tricks to steal data or money.
- Threats, or a concrete incitement to commit a crime.
- Publishing someone's personal data to harass or expose them.
- Anything else that is a crime in Chile.
- Content that infringes copyright, when its holder claims it.

## Reports and removal

- **Anyone can report** a link from the page where it is read: with a
  category, the reason and, if they agree, the link to read it, never the part
  that lets someone edit. A serious report (child abuse, threats or violence,
  concrete incitement, doxxing or intimate images) without that link stays on
  record but blocks nothing, because nobody could review it. If the link it
  brought does not open the document, the report is discarded as false.
- **A minor report** (spam, or something annoying or offensive that is no
  crime) needs nobody to step in. With three from different places and
  operators, whoever shared it sees a warning in their management link, also
  through Tisty, and has three days to send a new version. If they do not, it
  is no longer served until one arrives. A new version leaves those reports at
  zero.
- **With three reports** of phishing, malware, a scam or something serious, from
  different places, the document is blocked: it is no longer served, but it is
  not deleted. Whoever shared it sees the block in their management link and
  can appeal there. If someone they let edit signed every version reported, the
  appeal is accepted on its own, unless there is a report of child abuse: the
  edit link stops working, the reports stay on record, and it stays blocked
  until they send a version of their own. A block placed after reviewing the
  document by hand is only lifted by whoever reviewed it, and its appeal always
  goes to them.
- **Reports of crimes go where they belong:** to the PDI (Chile's
  investigations police) or the public prosecutor, and phishing and malware
  also to Google Safe Browsing and Cloudflare. Copyright claims are made by the
  rights holder, with a court order or a DMCA notice through Cloudflare.
- **The operator only opens what is encrypted** in four cases and always with
  the link to read it: when whoever shared it hands it over to
  show a block was a mistake, to review a serious report with the link its
  reporter handed over, to confirm phishing or malware before reporting it, or
  by a judge's order. Every opening is logged. What a report of child abuse
  points at, whether pictures, videos or other files, is never opened: the
  document is blocked, the least needed is kept, and the PDI or the prosecutor
  is told, with the link, so they open it themselves. In a browser, the code
  that decrypts comes from the same
  server; the [privacy policy](PRIVACY.md) says what that does not protect.
- **The operator may remove** any document that breaks these terms, and block
  access to anyone who abuses the service.

## What is yours

What you write is yours. Sharing it gives the operator no right over your
content beyond keeping it encrypted and serving it to whoever has the link,
for as long as it stays shared.

## No warranty

Folio is provided "as is", without warranty of any kind, as its
[licence](../LICENSE) also says. It may go down, lose what it keeps, change its
limits or cease to exist, with notice where possible. That is why your
document never leaves your Tisty.

## Liability

To the extent the law allows, the operator is not liable for loss or damage
arising from the use of Folio, nor for what other people share. Where the
law does not allow these limits, they apply as far as it permits.

## Changes

Every change to these terms is committed to the public repository, with its
date. Sharing after a change means accepting the new terms.

## Governing law

These terms are governed by the laws of Chile, and leave untouched any consumer
rights the law of your country gives you.

## Contact

Reports and appeals: <abuso@tisty.app>. Any other question:
<rgdevment@tisty.app>.

[Español](TERMINOS.md)
