export const SEALED_LINK_PREFIX = "sealed1.";

const SEALED_BODY = /^[A-Za-z0-9_-]{150,}$/;
const KEY_IN_A_LINK = /#[A-Za-z0-9_-]{43}/;

export const isSealedLink = (said: string): boolean =>
  said.startsWith(SEALED_LINK_PREFIX) && SEALED_BODY.test(said.slice(SEALED_LINK_PREFIX.length));

export const holdsALink = (said: string): boolean => KEY_IN_A_LINK.test(said);
