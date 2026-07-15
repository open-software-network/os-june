# Paid ads campaign proposal

- **Owner:** Growth
- **Date:** 2026-07-15
- **Status:** Proposal
- **Decision horizon:** Lean launch, with Growth and Scale gated on evidence

This document uses four evidence labels throughout:

- **Observed fact:** Verified from June, its public site, or a current source.
- **External benchmark:** Directional evidence from another product, study, or ad
  platform. It is not a June result.
- **Planning assumption:** An input chosen for budgeting or decision-making. It
  must be replaced with live June data when available.
- **Calculated output:** Arithmetic derived from stated observed facts and
  planning assumptions. It is a forecast, not measured performance.

## Executive decision

**Planning assumption:** Approve Lean as a six-week message and measurement
test. Do not pre-approve Growth or Scale. The business outcome is conversion
from Free to a paid Pro or Max subscription. The diagnostic path is:

`paid click -> completed Free account -> first-value activation -> paid within 60 days`

The job leads every message. Privacy is the reason to believe. The breadth of
the agent is the expansion story after a person understands the first job.

| Campaign tier | Evidence | Duration | Media cap | Setup, creative, and analysis cap | All-in cap | Decision |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Lean | Planning assumption | 6 weeks | $4,000 | $1,000 | $5,000 | Launch after Phase 0 |
| Growth | Planning assumption | 8 weeks | $17,000 | $3,000 | $20,000 | Hold until Lean gates pass |
| Scale | Planning assumption | 12 weeks | $54,000 | $6,000 | $60,000 | Hold until matured economics pass |

These are caps, not spending commitments. Reserved media never releases
automatically, and any stop rule can leave part of a cap unspent.

## Product and positioning diagnosis

**Observed fact:** June currently presents itself as "Private AI on your Mac"
and combines chat, dictation, bot-free meeting notes, and a local agent in one
private workspace. It is free to start. Pro is $20 per month and Max is $100
per month. The same privacy-preserving standard applies to every subscription
plan. The current feature and pricing claims are on the [June product
page](https://www.opensoftware.co/june).

**Observed fact:** June already has three public, intent-specific guides for
[private dictation for Mac](https://www.opensoftware.co/june/private-dictation-for-mac),
[AI meeting notes without a bot](https://www.opensoftware.co/june/ai-meeting-notes-without-a-bot),
and a [local AI agent](https://www.opensoftware.co/june/local-ai-agent). They
are useful starting assets, but their organic purpose should not substitute
for campaign-matched paid landing-page variants.

**External benchmark:** Adjacent products demonstrate active demand at several
price points, but none proves June's conversion or willingness to pay.
Wispr Flow lists Free and $15-per-user monthly Pro plans, Granola lists Free
and $14-per-user monthly Business plans, and Superwhisper lists a free product
plus Pro at $8.49 per month. See [Wispr Flow business
pricing](https://wisprflow.ai/business), [Granola
pricing](https://www.granola.ai/pricing), and [Superwhisper Pro
pricing](https://superwhisper.com/docs/get-started/sw-pro).

**External benchmark:** TechCrunch reported in June 2025 that Wispr Flow had
raised a $30 million Series A, said its user base was growing 50% month over
month, and attributed 40% of users to the US. This is a category-demand signal,
not a June forecast or a reason to copy that product's positioning. See the
[TechCrunch report](https://techcrunch.com/2025/06/24/wispr-flow-raises-30m-from-menlo-ventures-for-its-ai-powered-dictation-app/).

**Planning assumption:** Position June as **the private AI workspace for
confidential prosumers on Mac**. Acquire on one of three concrete jobs:

1. Write by speaking with dictation.
2. Capture meeting notes without a bot in the call.
3. Put a local, private agent to work across files and recurring tasks.

Dictation is the fastest first-value wedge. Bot-free meeting notes make a
clear trust and workflow claim. Local and private agent work shows June's
long-term breadth, but should not lead a cold ad with an abstract list of
features.

## Target customer and exclusions

**Planning assumption:** Prioritize these customer and job combinations:

| Audience | Job to lead with | Reason to believe | Likely paid plan |
| --- | --- | --- | --- |
| Founders and operators | Draft faster, capture decisions, prepare follow-through | Work stays local by default and model calls use private routing | Pro, with Max for heavy agent work |
| Consultants and advisors | Turn confidential conversations into notes and drafts | No bot joins the call, and notes stay on the Mac | Pro |
| Product, engineering, and design leads | Capture meetings, dictate specs, and work across files | One private workspace joins voice, notes, and agent work | Pro or Max |
| Independent professionals handling confidential work | Reduce typing and organize sensitive work | Privacy claims are open source and verifiable | Pro |

**Planning assumption:** Target context, role, job, and high-intent query.
Do not target or infer health conditions, financial hardship, legal disputes,
or other sensitive traits. Do not use ad creative that implies knowledge of a
person's private situation.

**Observed fact:** June's public page makes privacy and architecture claims,
but this proposal has no evidence that June is HIPAA compliant, SOC 2
certified, covered by legal privilege, or compliant with a specific regulated
workflow. Campaigns must not make those claims.

## Campaign architecture

### Funnel definitions

| Stage | Evidence | Working definition | Decision use |
| --- | --- | --- | --- |
| Paid click | Planning assumption | A valid platform-reported click to a wedge-specific June page | CPC and traffic quality |
| Completed Free account | Planning assumption | A person completes OS Accounts sign-up and reaches June on Free | Click-to-Free and cost per completed Free |
| First-value activation | Planning assumption | The first successful core job for the acquired wedge: a dictation lands, a meeting note finishes, or an agent task completes | Separates account creation from product value |
| Paid within 60 days | Planning assumption | A completed Free account starts Pro or Max within 60 days | Business outcome and CAC |

**Observed fact:** June already carries product signals for the fifth completed
meeting note, first completed agent task, and twenty-fifth completed dictation
to trigger a referral nudge. The [referral trigger
wiring](../../src/app/referral-nudge-triggers.ts) and [local trigger
state](../../src/lib/referral-nudge.ts) show that those value events exist in
the product. They do not join ad clicks to accounts and are not paid
attribution.

### Channel roles

| Channel | Earliest tier | Role | Guardrail |
| --- | --- | --- | --- |
| Google Search | Lean | Capture direct job and privacy intent with tightly matched ad groups | Start with exact and phrase match; review search terms before broadening |
| Reddit | Lean | Test contextual job messages in relevant professional and Mac communities | No customer lists, engagement retargeting, or automated audience expansion |
| YouTube | Growth | Demonstrate the product job and privacy proof in short, comprehensible creative | Start as creative and traffic learning until privacy-reviewed conversions exist |
| Microsoft Search | Scale | Test incremental desktop search inventory | Keep experimental because current SaaS benchmark conversion trails Google |
| LinkedIn | Scale | Max-only professional-role economics test | Broad role and industry context only; no sensitive inference or uploaded lists |

**Observed fact:** Google documents broad, phrase, and exact keyword match, with
each broader type reaching the queries of the narrower types. That supports a
controlled exact-and-phrase start for Lean. See [Google Ads keyword
matching](https://support.google.com/google-ads/answer/14996023).

**Observed fact:** Reddit's Audience Manager supports keyword, community,
interest, location, customer-list, and engagement-retargeting audiences, and
may expand targeting automatically. June should use contextual keywords,
communities, and geography only, with automated expansion disabled. See
[Reddit Audience Manager](https://business.reddithelp.com/articles/Knowledge/Audience-Manager).

**Observed fact:** YouTube supports traffic, reach, view, and conversion
campaigns. Sales, lead, and website-traffic conversion subtypes require
conversion setup. Until Phase 0 is accepted, YouTube should not optimize on a
user-level conversion feed. See [YouTube video campaign
setup](https://support.google.com/youtube/answer/2375497).

**External benchmark:** Unbounce reports a 5.1% median landing-page conversion
rate for Google search traffic in SaaS and 1.9% for Bing traffic. That supports
putting Microsoft Search behind the Scale gate rather than assuming it will
match Google. See the [Unbounce SaaS conversion
report](https://unbounce.com/conversion-benchmark-report/saas-conversion-rate/).

## Shared planning assumptions

**External benchmark:** The 2026 ChartMogul conversion report studied 200
software products and reports 8% median free-to-paid conversion within six
months. It calls 3% to 5% good and 8% to 12% great for regular freemium. June's
forecast uses a stricter 60-day window, so the benchmark is directional only.
See the [ChartMogul conversion
report](https://chartmogul.com/reports/saas-conversion-report/).

**External benchmark:** ProductLed reports roughly 9% average free-account to
paid conversion in its survey and emphasizes activation points, high-value
features, usage profile, and the first value moment as important signals. See
the [ProductLed benchmark
summary](https://productled.com/blog/product-led-growth-benchmarks).

**External benchmark:** Unbounce reports 3.8% median conversion for SaaS
landing pages, 4.1% for paid search traffic, and 2.9% for paid social traffic.
It also reports stronger results for simple copy. See the [Unbounce SaaS
conversion report](https://unbounce.com/conversion-benchmark-report/saas-conversion-rate/).

**External benchmark:** WordStream's 2025 Google Search data reports $5.58
average CPC and 5.14% average conversion for Business Services, while the
all-industry average CPC rose 12.88% year over year. June's CPC scenarios are
deliberately sensitivity inputs, not a promise to beat the market. See the
[WordStream 2025 Google Ads
benchmarks](https://www.wordstream.com/blog/2025-google-ads-benchmarks).

The same scenario inputs apply to every campaign tier:

| Scenario | Evidence | Blended CPC | Paid click to completed Free | Free to paid within 60 days | Paid mix | Weighted new MRR per subscriber |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| Conservative | Planning assumption | $4.50 | 4% | 3% | 95% Pro, 5% Max | $24 |
| Base | Planning assumption | $3.00 | 6% | 5% | 90% Pro, 10% Max | $28 |
| Upside | Planning assumption | $2.00 | 10% | 8% | 85% Pro, 15% Max | $32 |

**Calculated output:** Weighted new MRR is the paid mix multiplied by current
June prices. For example, base weighted MRR is `(90% x $20) + (10% x $100) =
$28`.

**Planning assumption:** The base target cost per completed Free account is
$50, calculated as `$3.00 / 6%`. This is a target for operating decisions, not
precise observed CAC.

## Lean / Growth / Scale plans

### Lean

**Planning assumption:** Run in the US only for six weeks.

| Allocation | Evidence | Amount | Share of media | Purpose |
| --- | --- | ---: | ---: | --- |
| Google Search | Planning assumption | $2,800 | 70% | High-intent wedge and privacy queries |
| Reddit | Planning assumption | $1,200 | 30% | Contextual message testing |
| Media total | Calculated output | $4,000 | 100% | Sum of channel caps |
| Setup and creative | Planning assumption | $1,000 | Not media | Three landing variants, search copy, static creative, reporting |
| All-in cap | Calculated output | $5,000 | Not applicable | Media plus setup and creative |

Lean is a message and measurement test. It is not designed to prove stable
paid CAC from a handful of conversions.

### Growth

**Planning assumption:** Run for eight weeks. Allocate geography 70% US, 10%
Canada, 10% UK, and 10% Australia unless live performance justifies a
documented reallocation.

| Allocation | Evidence | Amount | Share of media | Purpose |
| --- | --- | ---: | ---: | --- |
| Google Search | Planning assumption | $9,350 | 55% | Expand winning query and wedge cells |
| Reddit | Planning assumption | $3,400 | 20% | Expand winning contextual cells |
| YouTube | Planning assumption | $2,550 | 15% | Demonstration creative and traffic learning |
| Gated reserve | Planning assumption | $1,700 | 10% | Release only to a passing cell |
| Media total | Calculated output | $17,000 | 100% | Sum of channel caps and reserve |
| Setup, creative, and analysis | Planning assumption | $3,000 | Not media | Video production, landing iterations, and cohort analysis |
| All-in cap | Calculated output | $20,000 | Not applicable | Media plus non-media work |

**Calculated output:** The starting geographic media caps are $11,900 US and
$1,700 each for Canada, the UK, and Australia.

### Scale

**Planning assumption:** Run for twelve weeks. Start with the same 70% US, 10%
Canada, 10% UK, and 10% Australia split, subject to live performance.

| Allocation | Evidence | Amount | Share of media | Purpose |
| --- | --- | ---: | ---: | --- |
| Google Search | Planning assumption | $21,600 | 40% | Scale proven high-intent cells |
| Reddit | Planning assumption | $8,100 | 15% | Scale proven contextual cells |
| YouTube | Planning assumption | $10,800 | 20% | Scale proven demonstration creative |
| Microsoft Search | Planning assumption | $2,700 | 5% | Incremental search test |
| LinkedIn Max-only test | Planning assumption | $2,700 | 5% | Test professional acquisition against Max economics |
| Gated reserve | Planning assumption | $8,100 | 15% | Release only to a passing cell |
| Media total | Calculated output | $54,000 | 100% | Sum of channel caps and reserve |
| Creative and analysis | Planning assumption | $6,000 | Not media | Creative refreshes, landing iterations, and matured analysis |
| All-in cap | Calculated output | $60,000 | Not applicable | Media plus non-media work |

**Calculated output:** The starting geographic media caps are $37,800 US and
$5,400 each for Canada, the UK, and Australia.

No reallocation can bypass a channel pause, a wedge stop, the measurement
guardrail, or the reserve-release gate.

## Funnel and unit-economics scenarios

**Calculated output:** Forecasts below assume the full media cap is spent,
including gated reserve after it earns release. Expected clicks equal media
spend divided by blended CPC. Completed Free accounts equal clicks multiplied
by click-to-Free. Paid subscribers equal completed Free accounts multiplied by
60-day Free-to-paid. New MRR equals paid subscribers multiplied by weighted
new MRR. All-in CAC equals the all-in cap divided by paid subscribers. Gross-
revenue payback equals all-in CAC divided by weighted monthly revenue.

Fractional subscribers are mathematical expected values, not a claim that a
fractional customer can exist. Counts and currency are rounded for readability.

| Campaign tier | Scenario | Evidence | Expected clicks | Completed Free accounts | Paid subscribers within 60 days | New MRR | All-in CAC | Gross-revenue payback |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Lean | Conservative | Calculated output | 889 | 35.6 | 1.1 | $26 | $4,688 | 195.3 months |
| Lean | Base | Calculated output | 1,333 | 80.0 | 4.0 | $112 | $1,250 | 44.6 months |
| Lean | Upside | Calculated output | 2,000 | 200.0 | 16.0 | $512 | $313 | 9.8 months |
| Growth | Conservative | Calculated output | 3,778 | 151.1 | 4.5 | $109 | $4,412 | 183.8 months |
| Growth | Base | Calculated output | 5,667 | 340.0 | 17.0 | $476 | $1,176 | 42.0 months |
| Growth | Upside | Calculated output | 8,500 | 850.0 | 68.0 | $2,176 | $294 | 9.2 months |
| Scale | Conservative | Calculated output | 12,000 | 480.0 | 14.4 | $346 | $4,167 | 173.6 months |
| Scale | Base | Calculated output | 18,000 | 1,080.0 | 54.0 | $1,512 | $1,111 | 39.7 months |
| Scale | Upside | Calculated output | 27,000 | 2,700.0 | 216.0 | $6,912 | $278 | 8.7 months |

**Calculated output:** The base case does not support scaling: its all-in CAC
is above $1,100 and gross-revenue payback is roughly 40 to 45 months in every
campaign tier. Only upside Growth and Scale are near or below the $300 CAC and
12-month gross-revenue thresholds.

Gross-margin or contribution payback is longer than gross-revenue payback. It
cannot be calculated until Finance supplies gross margin and retention. The
table also does not model churn, refunds, referral lift, or expansion, so it
must not be presented as realized return on ad spend.

## Creative and landing-page matrix

Proposed copy below contains no named competitor. Each concept starts with the
job, uses privacy as proof, and introduces broader agent work only after the
first job is clear.

| Wedge | Primary audience | Proposed headline | Proposed proof line | Proposed CTA | Starting asset and required variant |
| --- | --- | --- | --- | --- | --- |
| Dictation | Founders, operators, independent professionals | "Write in any Mac app by speaking" | "Polished dictation in a private workspace on your Mac" | "Start Free" | Start from [private dictation for Mac](https://www.opensoftware.co/june/private-dictation-for-mac); add query-matched examples, Mac requirements, Free limits, and pricing |
| Bot-free meeting notes | Consultants, advisors, product and design leads | "Meeting notes without a bot in the call" | "Capture the conversation while notes and transcripts stay local by default" | "Download for Mac" | Start from [AI meeting notes without a bot](https://www.opensoftware.co/june/ai-meeting-notes-without-a-bot); add workflow demo, consent copy, Free limits, and pricing |
| Local and private agent | Founders, operators, product and engineering leads | "Put a private AI workspace to work on your Mac" | "Chat, files, research, and routines with a local agent and private routing" | "Start Free" | Start from [local AI agent](https://www.opensoftware.co/june/local-ai-agent); add one task demo, sandbox and approval proof, Free limits, and Max use case |

### Format matrix

| Format | Planning assumption | Minimum creative set |
| --- | --- | --- |
| Search | One tightly themed ad group per wedge and intent family | Two responsive search concepts per wedge, with job and privacy variations |
| Reddit static | Native-looking product proof, not fear-based privacy creative | One job screenshot and one architecture proof per wedge |
| YouTube | Demonstrate the completed job before architecture | One 15 to 20 second cut and one 30 to 45 second cut per passing wedge |
| LinkedIn Max-only | Show demanding professional workflow and Max outcome | One document or research workflow and one scheduled-routine workflow |

**External benchmark:** Unbounce reports that simpler SaaS landing copy
outperforms difficult copy and that 250 to 725 words produced the strongest
median result in its sample. Treat that as a useful editing constraint, not a
guarantee. Campaign variants should be concise, campaign-matched, and explicit
about macOS, Free, Pro, and Max.

## Measurement and privacy guardrails

### Phase 0 requirement

**Observed fact:** June's current telemetry is opt-in, off by default,
question-based, aggregate, and excludes user identifiers, subscription state,
billing activity, fine-grained timestamps, and marketing attribution. The
[public telemetry overview](../telemetry.md) and [P3A
PRD](../telemetry-p3a-prd.md) explicitly reject per-user funnels, retention
cohorts keyed to installs, and marketing attribution.

**Planning assumption:** Phase 0 must produce a separate privacy-reviewed
attribution design before paid media starts. It must document data flows,
retention, access, aggregation thresholds, consent, vendor configuration, and
deletion. It must preserve June P3A's hard line and must not quietly add ad
fields to product telemetry.

Until that design exists, Lean may use only:

- First-party aggregate counts for wedge landing visits and downloads.
- Coarse campaign cohorts or clearly disclosed promo codes, reported only in
  aggregates large enough to avoid singling out a person.
- Geo and time holdouts that compare aggregate movement without joining a
  person across systems.
- Platform-reported impressions, clicks, spend, CPC, and creative engagement.

These methods can estimate incrementality and cost per completed Free at a
coarse level. They cannot support a claim of precise paid CAC.

The following are prohibited in every campaign tier:

- Retargeting or engagement-retargeting audiences.
- Customer-list uploads or lookalikes seeded from customer lists.
- Cross-device identity graphs, device or install identifiers, and persistent
  person-level campaign joins.
- Invasive session replay or recording of form and page behavior.
- Per-user in-app ad attribution or adding campaign identity to June P3A.
- Targeting or creative based on inferred health, hardship, legal, or other
  sensitive traits.

**Observed fact:** Google documents conversion, conversion rate, conversion
value, cost per conversion, clicks, and CPC as Search metrics. June can use
click and cost reporting without accepting every available conversion-tracking
mechanism. See [Google Search campaign
metrics](https://support.google.com/google-ads/answer/9451527).

**Observed fact:** Reddit supports page visits, purchases, leads, sign-ups,
custom conversion events, a browser pixel, and a Conversions API. These
features exist, but June should not implement the pixel or API without Phase 0
approval. See [Reddit conversion
events](https://business.reddithelp.com/articles/Knowledge/supported-conversion-events).

**Observed fact:** LinkedIn offers conversion tracking and reporting by
professional traits such as job title, company, and industry. The Max-only test
should use broad role and industry context, platform aggregates, and no
customer-list or sensitive targeting. See [LinkedIn reporting and
analytics](https://business.linkedin.com/en-us/marketing-solutions/reporting-analytics).

### Operating scorecard

| Metric | Evidence | Use before Phase 0 is mature | Use after privacy review |
| --- | --- | --- | --- |
| Spend, clicks, and blended CPC | Observed platform output | Yes | Yes |
| Click to completed Free | Planning assumption, aggregate estimate | Directional only | Cohort aggregate if approved |
| Cost per completed Free | Planning assumption, aggregate estimate | Directional only | Cohort aggregate if approved |
| First-value activation | Planning definition | Cannot join to paid clicks | Coarse cohort aggregate if approved |
| Paid within 60 days | Business outcome | Cannot join to paid clicks | Matured cohort aggregate if approved |
| All-in CAC | Calculated forecast until design exists | Do not claim as observed | Calculate only from approved aggregate cohorts |
| Gross-margin payback | Finance-dependent output | Unavailable | Calculate after margin and retention inputs exist |

**Observed fact:** June ships a "Give a month, get a month" referral loop with
nudges after completed-value moments. Referral can lift total acquisition, but
it is organic upside. Do not credit referred subscribers to paid media or use
them as evidence that paid CAC passed.

## Experiment cadence and decision gates

### Cadence

| Period | Evidence | Required work |
| --- | --- | --- |
| Before week 1 | Planning assumption | Approve Phase 0, establish holdouts, freeze definitions, quality-check pages, and verify aggregate counts |
| Lean weeks 1 to 2 | Planning assumption | Launch all three wedges at controlled bids, review search terms and placements twice weekly, and resolve brand or privacy issues immediately |
| Lean weeks 3 to 4 | Planning assumption | Stop failed cells, refresh one variable at a time, and compare wedge-level click-to-Free only where traffic is sufficient |
| Lean weeks 5 to 6 | Planning assumption | Hold winning cells stable, do not force the cap to spend, and prepare the initial readout |
| Days 1 to 60 after each completed Free cohort | Planning assumption | Let conversion mature before using the cohort in a Free-to-paid or CAC gate |
| Growth and Scale | Planning assumption | Weekly operating review, fortnightly creative review, and a formal gate review only after the relevant cohort matures |

### Advancement gates

Move from Lean to Growth only when all of these are true:

- **Planning assumption:** Click-to-completed-Free is at least 6%.
- **Planning assumption:** Cost per completed Free is no more than $50.
- **Planning assumption:** Each compared wedge has enough qualified traffic to
  support a directional comparison. Use 300 qualified clicks per wedge as the
  minimum operating sample, not as a claim of statistical significance.
- **Planning assumption:** No unresolved privacy, policy, or brand issue exists.

Move from Growth to Scale only when all of these are true:

- **Planning assumption:** At least 30 paid conversions have matured through the
  60-day window.
- **Planning assumption:** 60-day Free-to-paid conversion is at least 8%.
- **Planning assumption:** Observed all-in CAC is no more than $300 under the
  privacy-reviewed aggregate design.
- **Planning assumption:** Finance can support a credible contribution payback of
  12 months or less using real gross margin and retention.
- **Planning assumption:** Max is at least 10% of paid subscribers, or Pro economics
  pass independently without relying on Max mix.

No reserved funds release automatically. A reserve can move only to a channel,
wedge, geography, and creative cell that has passed its applicable gate, has
room before a stop threshold, and remains distinguishable from organic in the
approved aggregate design.

### Stop and pause rules

- **Planning assumption:** Stop a wedge after 300 qualified clicks if
  click-to-completed-Free remains below 3%.
- **Planning assumption:** Pause a channel when cost per completed Free exceeds
  $100, which is two times the $50 target, and its acquired cohort shows no
  downstream first-value activation.
- **Planning assumption:** Stop all scaling if measurement cannot distinguish paid
  cohorts from organic at the approved aggregate level.
- **Planning assumption:** Pause immediately for a privacy, policy, misleading-copy,
  or brand issue. Diagnosis and review are required before restart.

## Dependencies, risks, and out of scope

| Item | Evidence | Risk or dependency | Required response |
| --- | --- | --- | --- |
| Attribution design | Observed gap | Current June P3A cannot measure the paid funnel | Complete separate Phase 0 privacy review before launch |
| Finance inputs | Observed gap | Gross margin and retention are missing | Finance supplies plan-level margin, retention, refunds, and contribution definition |
| Sixty-day lag | Planning assumption | Early optimization can reward cheap accounts that never pay | Use leading diagnostics, but mature cohorts before CAC gates |
| Landing variants | Planning assumption | Organic guides may not match paid queries or disclose the right pricing context | Build one campaign-matched variant per wedge and preserve the source guides |
| Creative production | Planning assumption | Agent breadth is difficult to explain in a cold static ad | Lead with one completed job and reserve breadth for the landing page or longer video |
| Referral loop | Observed fact | Referral lift can contaminate acquisition credit | Report referral separately and exclude it from paid CAC |
| Small geographic cells | Planning assumption | Canada, UK, and Australia can be noisy | Keep Growth and Scale splits coarse and reallocate only on passing evidence |
| Platform optimization | Observed capability | Conversion products can pressure the team toward user-level tracking | Keep conversion optimization off until Phase 0 explicitly approves a design |
| Product readiness | Planning assumption | Paid traffic magnifies onboarding, permission, and first-value friction | Treat activation as a required leading diagnostic, not a marketing afterthought |

Out of scope:

- A product pricing, Free-limit, onboarding, or subscription-plan change.
- A new telemetry question, wire field, device identifier, or billing join.
- Retargeting, customer-list activation, cross-device matching, or session
  replay.
- Sensitive-trait campaigns or claims of HIPAA, SOC 2, legal privilege, or
  regulatory compliance.
- Competitor-conquest ad copy or naming another product in proposed creative.
- Windows acquisition before the Mac funnel has passed the Scale gate.
- An assumption that referral or organic conversions belong to paid media.

## Sources

### June and internal product evidence

- [June product, privacy, guides, and pricing](https://www.opensoftware.co/june)
- [June telemetry overview](../telemetry.md)
- [June P3A PRD](../telemetry-p3a-prd.md)
- [Referral trigger state](../../src/lib/referral-nudge.ts)
- [Referral trigger wiring](../../src/app/referral-nudge-triggers.ts)

### Conversion and media benchmarks

- [ChartMogul 2026 SaaS conversion report](https://chartmogul.com/reports/saas-conversion-report/)
- [ProductLed product-led growth benchmarks](https://productled.com/blog/product-led-growth-benchmarks)
- [Unbounce SaaS conversion benchmark](https://unbounce.com/conversion-benchmark-report/saas-conversion-rate/)
- [WordStream 2025 Google Ads benchmarks](https://www.wordstream.com/blog/2025-google-ads-benchmarks)

### Platform documentation

- [Google Ads keyword matching](https://support.google.com/google-ads/answer/14996023)
- [Google Search campaign metrics](https://support.google.com/google-ads/answer/9451527)
- [Reddit Audience Manager](https://business.reddithelp.com/articles/Knowledge/Audience-Manager)
- [Reddit conversion events](https://business.reddithelp.com/articles/Knowledge/supported-conversion-events)
- [YouTube video campaign setup](https://support.google.com/youtube/answer/2375497)
- [LinkedIn reporting and analytics](https://business.linkedin.com/en-us/marketing-solutions/reporting-analytics)

### Adjacent-product evidence and price context

- [TechCrunch on Wispr Flow funding and growth](https://techcrunch.com/2025/06/24/wispr-flow-raises-30m-from-menlo-ventures-for-its-ai-powered-dictation-app/)
- [Wispr Flow business pricing](https://wisprflow.ai/business)
- [Granola pricing](https://www.granola.ai/pricing)
- [Superwhisper Pro pricing](https://superwhisper.com/docs/get-started/sw-pro)
