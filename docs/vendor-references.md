# Vendor references

The implementation was designed against the operator-facing FUJIFILM ArcSuite
Web Service Interface Reference Guide and the corresponding licensed WSDL,
with attention to these topics:

- service endpoint, namespace, WSDL discovery, and version negotiation;
- `getLoginInfo`, encrypted login, logout, and session information;
- ArcSuite Session header settings, request version, locale, and MTOM
  attachment behavior;
- Repository object search, listing, metadata retrieval, path retrieval, and
  revision listing;
- typed repository search conditions (`AttributeValue`, `BinaryOperatorCondition`,
  `SearchOption`, `SearchRegion`, and `TextSearchMode`);
- `AttributeSchema` data types, constraints, searchability, sortability, and
  the distinction between `I18nStringValue` system enum values and
  `StringValue` user enum values;
- Repository content retrieval with content labels and MTOM attachments;
- cabinet information and attribute schema metadata used for scope validation;
- SOAP faults and ArcSuite ProcessingException structures used to classify
  stable errors.

The exact guide revision, WSDL/XSD shape, namespaces, service DN, cabinet IDs,
root object, content labels, and Attribute IDs must be verified in the
operator's licensed ArcSuite environment. The example scope intentionally uses
placeholders and cannot be used against a real service unchanged.

Vendor-controlled manuals, PDFs, WSDL/XSD files, SDK binaries, sample source,
screenshots, and extracts are not redistributed in this repository. Obtain
them from the licensed environment. The hand-written adapter does not require
a WSDL at runtime; if an operator chooses a WSDL-based inspection or client
generation workflow, mount or fetch that user-supplied file outside version
control and outside MCP arguments.

No live ArcSuite endpoint or licensed service account was used for the public
tree's default tests. Passing the mock suite is not a claim of real-ArcSuite
qualification.
