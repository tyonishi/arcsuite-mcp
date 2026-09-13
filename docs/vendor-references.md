# Vendor references

ArcSuite MCP Server is an independent open-source project. Its source code and
project documentation are licensed separately from FUJIFILM Business
Innovation's ArcSuite software, SDK, Web Service Interface, documentation, and
other vendor-controlled materials.

## ArcSuite SDK / Web Service Interface license boundary

Use of the ArcSuite 4.0 Web Service Interface requires the operator to hold the
applicable ArcSuite 4.0 SDK license for the ArcSuite environment in which this
server is used. This repository's MIT license applies only to this project's
original source code and documentation; it does **not** include, grant, replace,
or sublicense any ArcSuite SDK or Web Service Interface rights.

The technical availability of an ArcSuite Web Service endpoint or WSDL does
not by itself grant a right to use that interface. Operators are responsible
for ensuring that their ArcSuite installation, SDK entitlement, credentials,
and intended use comply with the applicable FUJIFILM Business Innovation
license terms.

## Implementation references

The implementation was designed against the operator-facing FUJIFILM ArcSuite
Web Service Interface Reference Guide and the corresponding licensed WSDL,
with attention to these topics:

- service endpoint, namespace, WSDL discovery, and version negotiation;
- `getLoginInfo`, encrypted login, logout, and session information;
- ArcSuite Session header settings, request version, locale, and MTOM
  attachment behavior;
- Repository object search, listing, metadata retrieval, path retrieval, and
  revision listing;
- Repository content retrieval with content labels and MTOM attachments;
- cabinet information and attribute schema metadata used for scope validation;
- SOAP faults and ArcSuite ProcessingException structures used to classify
  stable errors.

The exact guide revision, WSDL/XSD shape, namespaces, service DN, cabinet IDs,
root object, content labels, and Attribute IDs must be verified in the
operator's ArcSuite environment covered by the applicable SDK license. The
example scope intentionally uses placeholders and cannot be used against a real
service unchanged.

## Vendor material handling

Vendor-controlled manuals, PDFs, WSDL/XSD files, SDK binaries, sample source,
screenshots, and vendor extracts are not redistributed in this repository.
Developers and operators must obtain those materials through their own licensed
ArcSuite/SDK channels.

The hand-written adapter does not require a WSDL at runtime. If an operator
uses a WSDL for implementation verification, inspection, interoperability
checking, or client-generation experiments, keep that WSDL/XSD material
outside version control and outside MCP arguments. The repository may contain
small, independently written synthetic contract fixtures needed to verify this
project's serializers/parsers, but must not reproduce the vendor WSDL, schema,
manual, or sample source.

No ArcSuite SDK license, vendor documentation license, or Web Service Interface
entitlement is conveyed by cloning, using, modifying, or redistributing this
repository.

## Qualification boundary

The public repository's default tests use synthetic fixtures and a mock
adapter. Unless a test explicitly states otherwise, they do not use a live
ArcSuite endpoint or a licensed service account. Passing repository CI proves
this project's implementation behavior only; it is not a claim of real-ArcSuite
qualification, vendor certification, support, or license compliance for a
particular deployment.
