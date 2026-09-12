## Summary

<!-- What changed and why? -->

## Security impact

- [ ] No mutation, administrator, privilege, ACL, delete, workflow, or
      arbitrary SOAP capability was added.
- [ ] Endpoint, cabinet, Attribute IDs, credentials, and session IDs remain
      outside MCP arguments/results.
- [ ] Content and log handling preserve the documented bounds/redaction.

## Tests

```text
Paste exact commands and results here.
```

## Documentation impact

- [ ] Documentation, ADRs, examples, and changelog updated as applicable.
- [ ] No vendor-controlled material was added.

## Public-hygiene confirmation

- [ ] I ran `npm run check:hygiene`.
- [ ] All values in tests/examples are synthetic.
- [ ] No private endpoint, identifier, personal information, secret, SOAP
      trace, WSDL, manual, SDK, or sample source is included.
