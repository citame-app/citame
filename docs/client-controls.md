# Client labels and booking access

In a client's directory detail, **Client tags & booking access** contains up to 20 labels. Labels are normalized to lowercase with Unicode normalization; duplicate, blank, oversized and control-character labels are rejected. Use commas between labels; commas and semicolons are not allowed inside an individual label. Directory search matches tags as well as contact fields and treats search wildcards literally.

Staff with client-edit permission can manage tags. Only owners and managers can change booking access, with a recorded private reason. The server recomputes these permissions from the current account; customer accounts and restricted staff cannot read these controls. Internal reasons are excluded from customer booking errors and audit metadata. Audit records identify changed fields and revision numbers.

- **Normal** applies the salon's usual booking rules.
- **Trusted** is an internal business marker. It does not bypass hours, availability, booking notice or calendar permissions. Future deposit exemptions must be explicitly configured, not inferred from this marker.
- **Blocked** prevents new appointments and actual changes of staff/time through the shared appointment domain, including REST, MCP and offline synchronization replay. Existing appointments and financial history remain intact; normal cancellation and outcome recording continue. An authorized manager can restore access with a new reason.

Tag/access writes use a separate optimistic revision. A concurrent change requires an explicit reload; an unsaved control draft is preserved. Control changes do not erase an unsaved contact draft. Legacy profile edits cannot overwrite these protected fields. The CRM editor participates in the detail page's unsaved-navigation guard.

Migration `0016` adds the controls to client profiles with safe defaults, leaving existing clients with normal access. Existing sync clients retain their current contact payload; shared server-side booking checks enforce the block when offline work reconnects. Advanced CRM photos, import/merge, forms and waivers remain separate expansion work.
