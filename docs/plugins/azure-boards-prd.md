# PRD: Azure Boards plugin

- **Mode:** CEO
- **Overall rank:** 19 of 20
- **Score:** 57/100
- **Date:** 2026-07-14
- **Status:** Proposed; Entra and tenant spike required

## Thesis

Azure Boards gives June a project-execution path for Microsoft-centered
engineering organizations. It should prepare from selected work items and
iterations, then create reviewed work items or comments from meeting outcomes.

Azure Boards ranks below GitLab and the general project tools because its ICP is
narrower, tenant administration is heavier, and new applications must use
Microsoft Entra ID while legacy Azure DevOps OAuth is deprecated.

## Customer and problem

Engineering planning context is split between meetings and work items. Manual
translation loses acceptance criteria, links, and owners. Broad Azure DevOps
permissions can also expose code, builds, and organization data unrelated to
the task.

## Product promise

Connect through Microsoft Entra ID, choose Azure DevOps organizations and
projects, and let June read or propose changes only within those boundaries.

## V1 experience

- Authorize a work or school account through Microsoft Entra ID.
- Select one Azure DevOps organization and projects.
- Search/read work items, comments, iterations, areas, queries, and boards.
- Create a work item or comment and update selected fields after approval.
- Preview organization, project, area, iteration, type, relations, and diff.
- Disconnect and revoke the Entra grant.

## Scope

### V1

- Azure DevOps Services with an Entra work or school account only, one
  organization, and a project allowlist.
- Work item, query, board, area, and iteration reads.
- Approved work item create, comment, and selected-field update.
- Local polling while June is awake.

### Later

- Azure DevOps Server, repos, pull requests, builds, pipelines, wikis,
  multiple organizations, service-hook routines, and broader Microsoft 365
  composition.

## Non-goals

- Microsoft personal accounts or personal access tokens for production setup.
- Legacy Azure DevOps OAuth registration.
- Code, pipeline, release, service connection, permission, or admin mutations.
- Arbitrary WIQL supplied by the model.

## Privacy and trust

Microsoft directs new Azure DevOps apps to Microsoft Entra ID and is
deprecating Azure DevOps OAuth in 2026. The Azure DevOps resource does not yet
natively support Microsoft personal accounts through Entra, so v1 is work and
school accounts only. The spike must prove a desktop public client, delegated
scopes, tenant consent, token audience, and revoke behavior. Project and area
selection are enforced in Rust.

Work item content is untrusted. All creates, comments, and updates are
approval-only in v1.

## Business model

Azure Boards is Pro because tenant setup and enterprise support dominate cost.
Provider API calls remain unmetered.

## Success measures

| Metric | Target |
| --- | ---: |
| Enabled users selecting a first project | 80% |
| Weekly connected users completing a work-item action | 30% |
| Actions needing project/type/area correction | under 5% |
| Access outside selected projects | 0 successful |
| New connections using legacy Azure DevOps OAuth | 0 |

## Risks and gates

- Entra tenant consent and Azure DevOps organization membership are distinct.
- Work item types, fields, rules, areas, and iterations vary per project.
- Service-hook scopes and legacy OAuth docs are in transition.
- Azure DevOps Server needs a separate auth and version strategy.

## Decision requested

Approve an Azure DevOps Services pilot through Entra ID only, limited to work
items in selected projects with approval-only actions.

## Sources

- [Azure DevOps service authorization](https://learn.microsoft.com/en-us/azure/devops/service-hooks/authorize?view=azure-devops)
- [Azure DevOps integrations with Microsoft Entra](https://learn.microsoft.com/en-gb/azure/devops/integrate/get-started/authentication/entra-oauth?view=azure-devops)
- [Azure DevOps OAuth migration guidance](https://learn.microsoft.com/en-gb/azure/devops/integrate/get-started/authentication/oauth?view=azure-devops)
- [Azure DevOps service hooks](https://learn.microsoft.com/en-us/azure/devops/service-hooks/overview?view=azure-devops)
- [Azure DevOps work items REST API](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items?view=azure-devops-rest-7.1)
