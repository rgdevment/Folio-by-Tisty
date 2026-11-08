export const SEALED_LINK_PREFIX = "sealed1.";

export const SEALED_CONTACT_PREFIX = "contact1.";
export const SEALED_CONTACT_AT_MOST = 512;

const SEALED_BODY = /^[A-Za-z0-9_-]{150,}$/;
const SEALED_CONTACT_BODY = /^[A-Za-z0-9_-]{80,}$/;
const KEY = "[A-Za-z0-9_-]{43}";
const ENDS = "(?![A-Za-z0-9_-])";
// Bare counts too, as it would sit in the database the same; only a path segment of another site's full address is let through.
const KEY_IN_A_LINK = new RegExp(
  [
    `(?<![A-Za-z0-9])[A-Za-z0-9]{8}#${KEY}`,
    `#${KEY}${ENDS}`,
    String.raw`tisty\.cl/${KEY}${ENDS}`,
    String.raw`(?<![A-Za-z0-9_-])(?<!://\S*/)${KEY}${ENDS}`,
  ].join("|"),
);

export const isSealedLink = (said: string): boolean =>
  said.startsWith(SEALED_LINK_PREFIX) && SEALED_BODY.test(said.slice(SEALED_LINK_PREFIX.length));

export const isSealedContact = (said: string): boolean =>
  said.length <= SEALED_CONTACT_AT_MOST &&
  said.startsWith(SEALED_CONTACT_PREFIX) &&
  SEALED_CONTACT_BODY.test(said.slice(SEALED_CONTACT_PREFIX.length));

export const holdsALink = (said: string): boolean => KEY_IN_A_LINK.test(said);
