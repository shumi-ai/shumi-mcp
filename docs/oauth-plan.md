# Unblocking OAuth for the hosted MCP

Status: **blocked on one decision that needs an account, everything else is specified.**
Written 2026-08-21 after probing the live server and Dynamic.

## Why this matters

`mcp.shumi.ai` is compliant on every axis a connector checks except authorization:

| requirement | state |
|---|---|
| Streamable HTTP over HTTPS at `/mcp` | ✅ |
| Protocol 2026-07-28 + legacy `initialize` | ✅ |
| JSON Schema 2020-12 on every tool | ✅ verified live |
| `outputSchema` on all 31 tools | ✅ since #22 |
| `annotations` (readOnlyHint / openWorldHint) | ✅ |
| ChatGPT `search`/`fetch` pair | not required — became optional in 2026 |
| **OAuth 2.1** | ❌ **dormant** |

Today the only way to authenticate is `Authorization: Bearer shumi_sk_*`, or the same key
pasted into the connector URL as `?apiKey=`. Claude's and ChatGPT's connector UIs have no
custom-header field, so the URL form is the only one that works — which puts a long-lived
secret into a third party's stored configuration, where it cannot be scoped or revoked
per-client.

## What Dynamic can and cannot do

Dynamic is our identity layer, so the obvious question is whether it can also be the
authorization server. **It cannot.** Probed 2026-08-21 against env `320a9117-…e178`:

```
https://app.dynamicauth.com/api/v0/sdk/<env>/.well-known/jwks                    200
https://app.dynamicauth.com/api/v0/sdk/<env>/.well-known/openid-configuration    404
https://app.dynamicauth.com/api/v0/sdk/<env>/.well-known/oauth-authorization-server  404
```

Same result on `app.dynamic.xyz`. Dynamic **issues** JWTs and publishes a JWKS so we can
verify them (`cli/lib/verifyDynamicJWT.js` already does), and it acts as an OAuth *client*
against Google/X/etc. It does not expose `/authorize`, `/token`, dynamic client
registration, or a discovery document — the four things an MCP client needs to complete
the flow. Its "Bring Your Own Auth" product points the other way: it consumes a JWT you
already issued.

So Dynamic stays the **identity** layer. Something else has to be the **authorization**
layer, with the Dynamic user id as the token subject.

## What the spec now requires

MCP 2026-07-28 changed client registration: **Dynamic Client Registration (RFC 7591) is
deprecated** in favour of **Client ID Metadata Documents** — a client identifies itself
with an HTTPS URL that serves its own metadata. Anything built now should target CIMD and
treat DCR as the compatibility path, not the primary one.

The resource-server half is small and already written (`src/http-server.js`):

- RFC 9728 protected-resource metadata at `/.well-known/oauth-protected-resource`
- a `401` carrying `WWW-Authenticate: Bearer resource_metadata="…"`

Both are gated behind `SHUMI_MCP_AUTH_SERVER`, which is unset in production, so both are
inert and the well-known path 404s. That gating is correct — advertising a metadata
document that points at no authorization server would be worse than advertising nothing.

## The decision that is actually blocked

Picking and provisioning the authorization server. Three viable shapes:

1. **Stytch Connected Apps.** What the existing code comment already anticipates ("the thin
   Stytch-over-Dynamic AS"). Purpose-built for MCP, ships DCR, and is the least code.
   Requires an account and production credentials.
2. **A hosted general AS** (WorkOS / Auth0 / Scalekit). More generic, more configuration,
   same account requirement.
3. **Self-hosted** (`panva/node-oidc-provider`). No third-party dependency and no per-MAU
   cost, but we then own token storage, rotation, consent UI and the security surface —
   on a two-person team, for a server whose current MCP traffic is near zero.

**I did not pick one, because all three need an account or a spend commitment that is not
mine to make.** That is the single blocker; there is no technical unknown left.

## What happens once one is chosen

1. Set `SHUMI_MCP_AUTH_SERVER` and `SHUMI_MCP_PUBLIC_URL` on the Render service. The
   metadata document and the `401` challenge light up with no code change.
2. Add token verification at the edge: today the bearer is forwarded upstream unexamined.
   Under OAuth the resource server must verify the signature, the issuer, and — the part
   most implementations miss — that the token's **audience is this resource**
   (RFC 8707). Without the audience check, a token minted for any other resource by the
   same AS is accepted here.
3. Map the token subject to a Shumi user. The existing `cli/lib/userProvision.js` lookup
   order (dynamicUserId → email → wallet) is the model to reuse, so an OAuth session and a
   `shumi_sk_*` key resolve to the same account and the same entitlement.
4. Keep `shumi_sk_*` working. It is what the CLI, stdio and Smithery use, and it must not
   be collateral damage of adding a second scheme.

## Not worth doing first

Submitting to Claude's connector directory. That needs a Team or Enterprise organisation
on top of OAuth, and the directory is a distribution channel for a server that already
works — not a prerequisite for one.
