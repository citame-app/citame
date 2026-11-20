# ADR 0019: Document policy for WhatsApp Embedded Signup

Status: accepted

Meta Embedded Signup uses the Facebook JavaScript SDK and a cross-origin popup opened from the owner's WhatsApp settings. The default document policy in [ADR 0011](0011-production-hardening.md) protects the rest of the application.

Only the `/admin/whatsapp` HTML response permits the Meta script, connections, images and frames needed for the flow. Its `Cross-Origin-Opener-Policy: same-origin-allow-popups` lets the document communicate with the popup it opens. The existing nonce remains in the script policy. Session, OAuth and API authorization are independent of the document policy.

The router records the policy scope once per browser document. Navigating from either side of the boundary loads a new HTML response, applying the correct headers before rendering the destination. The Settings link opens the WhatsApp document directly. Ordinary admin navigation keeps its existing client-side transitions.
