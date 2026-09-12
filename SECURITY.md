# Security policy

ArcSuite MCP Server is designed as a read-only semantic gateway. It keeps
ArcSuite SOAP details, session identifiers, cabinet mappings, and credentials
behind a server-side adapter boundary.

## Reporting a vulnerability

Please do not include credentials, session identifiers, private endpoints,
document contents, SOAP traces, or vendor files in an issue. Use a private
GitHub security advisory for this repository when available; otherwise contact
the repository maintainers through the private channel configured for the
repository.

Include the affected version or commit, a minimal reproduction that contains
only synthetic values, impact, and a proposed mitigation if known.

## Deployment expectations

Run the MCP endpoint behind TLS and an authenticated network boundary. Keep
the Java adapter on a private network, mount secrets rather than placing them
in configuration files, and use a user-supplied scope registry that has been
validated against the licensed ArcSuite environment.

The project does not claim qualification against every ArcSuite release or
MCP client. Review the operator's ArcSuite documentation and perform an
environment-specific security review before production use.
