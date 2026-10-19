/**
 * Why the instance refused an SSO sign-in. The server refuses the callback with one of these
 * codes, Better Auth returns the browser to the login page with it, and the page explains it.
 */
export const SsoRefusal = {
  emailUnverified: "sso_email_unverified",
  domainNotAllowed: "sso_domain_not_allowed",
  notMember: "sso_not_member",
  instanceNotReady: "sso_instance_not_ready",
} as const;

const explanations: Readonly<Record<string, string>> = {
  [SsoRefusal.emailUnverified]:
    "Your identity provider did not confirm that this email address is verified. Ask your administrator to have the provider mark it verified.",
  [SsoRefusal.domainNotAllowed]:
    "This email is not from a domain approved for SSO on this instance. Use an approved account or contact your administrator.",
  [SsoRefusal.notMember]:
    "Your account is not a member of this instance. Contact your administrator.",
  [SsoRefusal.instanceNotReady]:
    "This instance is not set up yet. Ask your administrator to finish setup.",
  // Better Auth links SSO only to an account whose email was verified, and password accounts
  // here never are.
  account_not_linked:
    "This email already has a password account on this instance. Sign in with your password.",
};

/** The explanation for a callback error code; unknown codes get a general one. */
export const ssoRefusalExplanation = (code: string): string =>
  explanations[code] ??
  "SSO sign-in failed. Use an approved account or contact your administrator.";
