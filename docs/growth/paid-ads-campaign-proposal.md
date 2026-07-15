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

**Planning assumption:** Propose Lean as a six-week message and measurement
test. Do not pre-approve Growth or Scale. The business outcome is conversion
from Free to a paid Pro or Max Plan. The diagnostic path is:

`paid click -> completed Free account -> first-value activation -> paid within 60 days`

The job leads every message. Privacy is the reason to believe. The breadth of
June's agent is the expansion story after a person understands the first job.

| Campaign tier | Evidence | Duration | Media cap | External cash setup, creative, and analysis cap | Campaign cash cap | Decision |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Lean | Planning assumption | 6 weeks | $4,000 | $1,000 | $5,000 | Launch only after Phase 0, dry run, cap acceptance, and named approval |
| Growth | Planning assumption | 8 weeks | $17,000 | $3,000 | $20,000 | Hold until matured Lean economics pass |
| Scale | Planning assumption | 12 weeks | $54,000 | $6,000 | $60,000 | Hold until matured economics pass |

Campaign cash means media plus the stated external cash setup, creative, and
analysis allowance. These are caps, not spending commitments. Reserved media
never releases automatically, and any stop rule can leave part of a cap unspent.
Evidence never substitutes for named release authority.

## Product and positioning diagnosis

**Observed fact:** June currently presents itself as "Private AI on your Mac"
and combines chat, dictation, bot-free meeting notes, and a local agent in one
private workspace. It is free to start. Pro is $20 per month and Max is $100
per month. The same privacy-preserving standard applies to every Plan. The
current feature and pricing claims are on the [June product
page](https://www.opensoftware.co/june).

**Observed fact:** June already has three public, intent-specific guides for
[private dictation for Mac](https://www.opensoftware.co/june/private-dictation-for-mac),
[AI meeting notes without a bot](https://www.opensoftware.co/june/ai-meeting-notes-without-a-bot),
and a [local AI agent](https://www.opensoftware.co/june/local-ai-agent). They
are useful starting assets, but their organic purpose should not substitute
for campaign-matched paid landing-page variants.

**Research-scope exception:** This proposal was explicitly commissioned to use
current evidence from similar products. Named products are therefore limited
to attributed research evidence and sources; campaign copy and positioning
must not name or compare them.

**External benchmark:** Adjacent products provide price context at several
levels, but their pricing does not establish demand for June or prove June's
conversion or willingness to pay.
Wispr Flow lists Free and a $15-per-user monthly Pro offering, Granola lists
Free and a $14-per-user monthly Business offering, and Superwhisper lists a
free product plus Pro at $8.49 per month. See [Wispr Flow business
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
3. Turn selected files into a finished brief with the local agent.

Dictation is the fastest first-value wedge. Bot-free meeting notes make a
clear trust and workflow claim. A concrete file-to-brief job leads the local agent
wedge. Broader research, file, and routine work belongs in the landing-page
expansion story, not the cold-ad headline.

## Target customer and exclusions

**Planning assumption:** Prioritize these customer and job combinations:

| Audience | Job to lead with | Reason to believe | Likely paid Plan |
| --- | --- | --- | --- |
| Founders and operators | Draft faster, capture decisions, prepare follow-through | Work stays local by default and model calls use private routing | Pro, with Max for heavy local-agent work |
| Consultants and advisors | Turn confidential conversations into notes and drafts | No bot joins the call, and notes stay on the Mac | Pro |
| Product, engineering, and design leads | Capture meetings, dictate specs, and work across files | One private workspace joins voice, notes, and June's agent work | Pro or Max |
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
| First-value activation | Planning assumption | The first successful core job for the acquired wedge: a dictation lands, a meeting note finishes, or a local agent task completes | Separates account creation from product value |
| Paid within 60 days | Planning assumption | A completed Free account starts a Pro or Max Plan within 60 days | Business outcome and acquisition cost |

**Observed fact:** June already carries product signals for the fifth completed
meeting note, first completed local agent task, and twenty-fifth completed dictation
to trigger a referral nudge. The [referral trigger
wiring](../../src/app/referral-nudge-triggers.ts) and [local trigger
state](../../src/lib/referral-nudge.ts) show that those value events exist in
the product. They do not join ad clicks to accounts and are not paid
attribution.

### Paid acquisition channel roles

| Paid acquisition channel | Earliest campaign tier | Role | Guardrail |
| --- | --- | --- | --- |
| Google Search | Lean | Capture direct job and privacy intent with tightly matched ad groups | Start with exact and phrase match; review search terms before broadening |
| Reddit | Lean | Test contextual job messages in relevant professional and Mac communities | No customer lists, engagement retargeting, or automated audience expansion |
| YouTube | Growth | Demonstrate the product job and privacy proof in short, comprehensible creative | Start as creative and traffic learning until privacy-reviewed conversions exist |
| Microsoft Search | Scale | Test incremental desktop search inventory | Keep experimental because current SaaS benchmark conversion trails Google |
| LinkedIn | Scale | Max Plan file-to-brief economics test | Broad role and industry context only; no sensitive inference or uploaded lists |

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

| Scenario | Evidence | Blended CPC | Paid click to completed Free | Free to paid within 60 days | Paid Plan mix | Weighted new MRR per paid Plan |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| Conservative | Planning assumption | $4.50 | 4% | 3% | 95% Pro, 5% Max | $24 |
| Base | Planning assumption | $3.00 | 6% | 5% | 90% Pro, 10% Max | $28 |
| Upside | Planning assumption | $2.00 | 10% | 8% | 85% Pro, 15% Max | $32 |

**Calculated output:** Weighted new MRR is the paid Plan mix multiplied by
current June prices. For example, base weighted MRR is `(90% x $20) + (10% x
$100) = $28`.

**Planning assumption:** The base target cost per completed Free account is
$50, calculated as `$3.00 / 6%`. This is a target for operating decisions, not
a precise observed acquisition-cost result.

## Lean / Growth / Scale plans

**Planning assumption:** A paid acquisition cell combines one wedge and one
geography on one paid acquisition channel. Creative variants are nested within
that cell and do not create a new cell or reset its evidence.

### Lean

**Planning assumption:** Run in the US only for six weeks.

**Planning assumption:** Before any Lean media or external campaign cash
releases, Phase 0 must be approved, the full dry run must pass, and the $4,000
media cap, $1,000 external cash cap, and $5,000 campaign cash cap must be
accepted. Growth, Finance, and the privacy reviewer must then each give fresh
named approval for Lean launch.

| Allocation | Evidence | Amount | Share of media | Purpose |
| --- | --- | ---: | ---: | --- |
| Google Search | Planning assumption | $2,800 | 70% | High-intent wedge and privacy queries |
| Reddit | Planning assumption | $1,200 | 30% | Contextual message testing |
| Media total | Calculated output | $4,000 | 100% | Sum of paid acquisition channel caps |
| External cash setup and creative | Planning assumption | $1,000 | Not media | Search copy, static creative, and campaign reporting |
| Campaign cash cap | Calculated output | $5,000 | Not applicable | Media plus stated external cash work |

Lean is a message and measurement test. It is not designed to prove stable
campaign cash CAC from a handful of conversions.

### Growth

**Planning assumption:** Run for eight active media weeks. The cumulative
geographic media caps are hard maxima: 70% US, 10% Canada, 10% UK, and 10%
Australia. No approval, cell pass, reserve release, or reallocation may exceed
them.

Growth is a controlled paid-economics validation tier, not permission to scale
automatically. It tests whether the matured Lean signal survives more spend,
more geography, and one additional paid acquisition channel while reserve
remains gated.

| Allocation | Evidence | Amount | Share of media | Purpose |
| --- | --- | ---: | ---: | --- |
| Proven US Google Search cells | Planning assumption | $6,800 | 40% | Continue only Lean cells that pass |
| Proven US Reddit cells | Planning assumption | $2,550 | 15% | Continue only Lean cells that pass |
| New-cell test reserve | Planning assumption | $7,650 | 45% | Hold all YouTube and non-US cell funding until cell-level release |
| Media total | Calculated output | $17,000 | 100% | Proven-cell caps plus new-cell test reserve |
| External cash setup, creative, and analysis | Planning assumption | $3,000 | Not media | External video production and campaign analysis |
| Campaign cash cap | Calculated output | $20,000 | Not applicable | Media plus stated external cash work |

**Calculated output:** After cells earn release, the maximum geographic media
envelopes remain $11,900 US and $1,700 each for Canada, the UK, and Australia.
The $7,650 test reserve contains the $2,550 US YouTube envelope plus all $5,100
for Canada, the UK, and Australia.

Growth has four sequential $5,000 campaign cash release tranches:

| Growth tranche | Evidence | Media | External cash work | Campaign cash cap | Release authority |
| --- | --- | ---: | ---: | ---: | --- |
| 1 | Planning assumption | $4,250 | $750 | $5,000 | Lean may authorize only this tranche after every Lean-to-Growth gate passes |
| 2 | Planning assumption | $4,250 | $750 | $5,000 | Intra-Growth release gate |
| 3 | Planning assumption | $4,250 | $750 | $5,000 | Intra-Growth release gate |
| 4 | Planning assumption | $4,250 | $750 | $5,000 | Intra-Growth release gate |
| Total | Calculated output | $17,000 | $3,000 | $20,000 | Full Growth cap; never committed at entry |

**Planning assumption:** Growth retains eight weeks of active media execution
across released tranches. Sixty-day maturity holds pause the calendar and do
not count as active media weeks. Each released tranche must deliver at least
80% of its $4,250 media cap, or $3,400, unless a stop rule ends the tranche. A
stopped or underexposed tranche cannot authorize the next Growth tranche or
Scale.

### Scale

**Planning assumption:** Run for twelve active media weeks. The cumulative
geographic media caps are hard maxima: 70% US, 10% Canada, 10% UK, and 10%
Australia. No approval, cell pass, reserve release, or reallocation may exceed
them. Every new Scale paid acquisition channel remains reserved until its cells
pass.

| Allocation | Evidence | Amount | Share of media | Purpose |
| --- | --- | ---: | ---: | --- |
| Google Search | Planning assumption | $21,600 | 40% | Scale proven high-intent cells |
| Reddit | Planning assumption | $8,100 | 15% | Scale proven contextual cells |
| YouTube | Planning assumption | $10,800 | 20% | Scale proven demonstration creative |
| New paid acquisition channel and cell test reserve | Planning assumption | $13,500 | 25% | Hold every Microsoft Search, LinkedIn, and other new cell test |
| Media total | Calculated output | $54,000 | 100% | Proven paid acquisition channel caps plus test reserve |
| External cash creative and analysis | Planning assumption | $6,000 | Not media | External creative refreshes and matured campaign analysis |
| Campaign cash cap | Calculated output | $60,000 | Not applicable | Media plus stated external cash work |

**Calculated output:** The maximum geographic media envelopes are $37,800 US
and $5,400 each for Canada, the UK, and Australia after cells earn release.

Scale has four sequential $15,000 campaign cash release tranches:

| Scale tranche | Evidence | Media | External cash work | Campaign cash cap | Active media | Release authority |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Planning assumption | $13,500 | $1,500 | $15,000 | 3 weeks | The Growth-to-Scale gate may authorize only this tranche |
| 2 | Planning assumption | $13,500 | $1,500 | $15,000 | 3 weeks | Intra-Scale release gate |
| 3 | Planning assumption | $13,500 | $1,500 | $15,000 | 3 weeks | Intra-Scale release gate |
| 4 | Planning assumption | $13,500 | $1,500 | $15,000 | 3 weeks | Intra-Scale release gate |
| Total | Calculated output | $54,000 | $6,000 | $60,000 | 12 weeks | Full Scale cap; never committed at entry |

**Planning assumption:** A Scale tranche cohort is mature only after its
60-day and approved refund/cancellation windows close. Tranches 2 to 4 use the
named Intra-Scale release gate below. Each released Scale tranche must deliver
at least 80% of its $13,500 media cap, or $10,800, unless a stop rule ends it.
A stopped or underexposed Scale tranche cannot authorize the next tranche.

No reallocation can bypass a paid acquisition channel pause, a wedge stop, the
measurement guardrail, or the reserve-release gate.

## Funnel and unit-economics scenarios

**Calculated output:** Forecasts below assume the full media cap is spent,
including gated reserve after it earns release. Expected clicks equal media
spend divided by blended CPC. Completed Free accounts equal clicks multiplied
by click-to-Free. Paid Plan starts equal completed Free accounts multiplied by
60-day Free-to-paid. New MRR equals paid Plan starts multiplied by weighted new
MRR. Campaign cash CAC equals the campaign cash cap divided by paid Plan
starts. Campaign cash gross-revenue payback equals campaign cash CAC divided by
weighted monthly revenue.

**Planning assumption:** For scenario arithmetic only, every modeled paid Plan
start is treated as a net matured incremental paid Plan start. Live gates must
replace that simplification with the approved estimator and treatment rules.

Fractional paid Plan counts are mathematical expected values, not a claim that
a fractional customer can exist. Counts and currency are rounded for
readability.

| Campaign tier | Scenario | Evidence | Expected clicks | Completed Free accounts | Paid Plan starts within 60 days | New MRR | Campaign cash CAC | Campaign cash gross-revenue payback |
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

**Calculated output:** The base case does not support scaling: its campaign
cash CAC is above $1,100 and campaign cash gross-revenue payback is roughly 40
to 45 months in every campaign tier. Lean Upside is near the $300 campaign cash
CAC threshold at $313, while Growth Upside and Scale Upside are below it at
$294 and $278. All three Upside scenarios are below 12 months of campaign cash
gross-revenue payback.

The forecast models three distinct acquisition-cost boundaries:

- **Media CAC:** Media spend divided by net matured incremental paid Plan
  starts.
- **Campaign cash CAC:** Media plus the stated external cash setup, creative,
  and analysis allowance, divided by net matured incremental paid Plan starts.
- **Fully loaded contribution CAC:** Campaign cash spend plus incremental
  internal Growth labor, privacy and legal review, engineering, tooling,
  landing work, and incremental Free credits and usage, divided by net matured
  incremental paid Plan starts.

Retention-aware fully loaded contribution payback is the first month when the
acquired cohort's cumulative expected contribution reaches fully loaded
contribution CAC under the conservative bound. Expected contribution in every
month is net of retention, cancellations, refunds, promotions and credits, and
contribution margin. If cumulative expected contribution never recovers fully
loaded contribution CAC within the cohort's expected lifetime, the gate fails.

This retention-aware contribution measure is separate from the forecast
table's campaign cash gross-revenue payback, which remains campaign cash CAC
divided by weighted new MRR. None of the nine scenario formulas or values
change. Finance must supply the monthly retention curve, expected lifetime,
cancellation and refund treatment, promotion and credit treatment, and
Plan-level contribution margin before the retention-aware measure is
available. The table also does not model churn, refunds, referral lift, or
expansion, so it must not be presented as realized return on ad spend.

## Creative and landing-page matrix

Proposed copy below contains no named competitor. Each concept starts with the
job, uses privacy as proof, and introduces broader local-agent work only after
the first job is clear.

| Wedge | Primary audience | Proposed headline | Proposed proof line | Proposed CTA | Starting asset and required variant |
| --- | --- | --- | --- | --- | --- |
| Dictation | Founders, operators, independent professionals | "Write in any Mac app by speaking" | "Polished dictation in a private workspace on your Mac" | "Start free" | Start from [private dictation for Mac](https://www.opensoftware.co/june/private-dictation-for-mac); add query-matched examples, Mac requirements, Free limits, and pricing |
| Bot-free meeting notes | Consultants, advisors, product and design leads | "Meeting notes without a bot in the call" | "Capture the conversation while notes and transcripts stay local by default" | "Download for Mac" | Start from [AI meeting notes without a bot](https://www.opensoftware.co/june/ai-meeting-notes-without-a-bot); add workflow demo, consent copy, Free limits, and pricing |
| Local and private agent | Founders, operators, product and engineering leads | "Turn a folder of files into a finished brief" | "A local agent works across the files you choose, with private routing and approval for risky actions" | "Start free" | Start from [local AI agent](https://www.opensoftware.co/june/local-ai-agent); lead with one folder-to-brief demo, then expand to research, files, and routines lower on the page |

### Format matrix

| Format | Planning assumption | Minimum creative set |
| --- | --- | --- |
| Search | One tightly themed ad group per wedge and intent family | Two responsive search concepts per wedge, with job and privacy variations |
| Reddit static | Native-looking product proof, not fear-based privacy creative | One job screenshot and one architecture proof per wedge |
| YouTube | Demonstrate the completed job before architecture | One 15 to 20 second cut and one 30 to 45 second cut per passing wedge |
| LinkedIn Max Plan | Lead with a demanding file-to-brief job and Max Plan outcome | Two file-to-brief variants with different professional source sets and the same finished-brief outcome |

**External benchmark:** Unbounce reports that simpler SaaS landing copy
outperforms difficult copy and that 250 to 725 words produced the strongest
median result in its sample. Treat that as a useful editing constraint, not a
guarantee. Campaign variants should be concise, campaign-matched, and explicit
about macOS, Free, Pro, and Max.

## Measurement and privacy guardrails

### Phase 0 requirement

**Observed fact:** June's current telemetry is opt-in, off by default,
question-based, and aggregate. It excludes user identifiers, OS Accounts
subscription state, billing activity, fine-grained timestamps, and marketing
attribution. The
[public telemetry overview](../telemetry.md) and [P3A
PRD](../telemetry-p3a-prd.md) explicitly reject per-user funnels, retention
cohorts keyed to installs, and marketing attribution.

**Planning assumption:** Phase 0 must produce and approve a separate
privacy-reviewed measurement contract before paid media starts. It must keep
June P3A separate and must not add ad fields to product telemetry. The contract
must freeze every item below before launch:

| Contract item | Evidence | Required frozen decision |
| --- | --- | --- |
| Assignment unit | Planning assumption | Define the pre-registered paid acquisition cell and coarse cohort window, plus geo or time holdout assignment; creative variants remain nested inside a cell |
| Data flow and consent | Planning assumption | Document each source, destination, vendor, consent surface, and vendor configuration while keeping June P3A separate |
| Measurement health | Planning assumption | Define continuous source-to-scorecard availability, contamination, and paid-versus-organic distinction checks, alert ownership, the fail-closed latch, and a privacy-reviewed reconciliation procedure for every affected cohort and window |
| Gate definitions | Planning assumption | Fix the numerator, denominator, minimum sample, maturity window, exclusions, and source system for every rate, cost, Plan-mix, and payback gate |
| Tranche exposure | Planning assumption | Require at least 80% of each released media cap unless a stop rule ends the tranche; a stopped or underexposed tranche cannot authorize the next campaign tier or tranche |
| Cohort persistence | Planning assumption | Keep only a thresholded aggregate cohort key stable through its activation, 60-day paid, refund, and cancellation windows; never persist a person-level campaign join |
| Incrementality estimator | Planning assumption | Pre-register the holdout estimator, comparison periods, contamination handling, and a conservative one-sided uncertainty bound; do not substitute a raw point estimate or change the method after results are visible |
| Aggregation threshold | Planning assumption | Freeze the minimum reportable cohort size and suppression rule for every output; no gate may rely on a suppressed or under-threshold cell |
| Paid Plan treatment | Planning assumption | Define how Plan starts, upgrades, refunds, cancellations, and promotional periods become net matured incremental paid Plan starts |
| Contribution recovery model | Planning assumption | Freeze the monthly retention curve, expected lifetime, cancellation and refund treatment, promotion and credit treatment, contribution margin, and conservative recovery bound |
| Shared-cost allocation | Planning assumption | Before results are visible, pre-register how shared external campaign cash and fully loaded internal costs are allocated to campaign tiers, tranches, cells, and increments; cell CAC and payback must be executable and no cost may move post hoc |
| Referral treatment | Planning assumption | Identify referrals in aggregate, report them separately, and exclude them from every paid-media numerator and acquisition-cost result |
| Retention and deletion | Planning assumption | Set purpose-limited retention through the last maturity window and a verified deletion schedule for cohort keys and vendor data |
| Access | Planning assumption | Name the privacy reviewer who controls aggregate production and limit Growth and Finance to thresholded scorecard outputs, never person rows |
| Proof of computability | Planning assumption | Run synthetic or historical data through the full contract and reproduce every gate, Plan-mix result, and reserve decision before Lean launches |

The frozen gate arithmetic is:

| Metric | Evidence | Numerator | Denominator or recovery threshold |
| --- | --- | --- | --- |
| Click-to-completed-Free | Planning assumption | Matured incremental completed Free accounts assigned by the pre-registered estimator | Valid platform-reported paid clicks in the same cell and cohort window |
| Cost per completed Free | Planning assumption | Paid media spend in the same cell and cohort window | Matured incremental completed Free accounts |
| Seven-day first-value activation | Planning assumption | Matured incremental completed Free accounts that complete the wedge's first-value job within seven days | Incremental completed Free accounts matured for seven days |
| Free-to-paid within 60 days | Planning assumption | Net matured incremental Pro and Max Plan starts within 60 days, excluding referrals | Matured incremental completed Free accounts |
| Paid Plan mix | Planning assumption | Net matured incremental starts for the named Plan | All net matured incremental paid Plan starts |
| Media CAC | Calculated output | Paid media spend | Net matured incremental paid Plan starts |
| Campaign cash CAC | Calculated output | Paid media plus stated external cash setup, creative, and analysis | Net matured incremental paid Plan starts |
| Fully loaded contribution CAC | Calculated output | Campaign cash spend plus incremental internal Growth labor, privacy and legal review, engineering, tooling, landing work, and incremental Free credits and usage | Net matured incremental paid Plan starts |
| Retention-aware fully loaded contribution payback | Calculated output | Cumulative expected contribution through month m under the conservative bound, net each month of retention, cancellations, refunds, promotions and credits, and contribution margin | Fully loaded contribution CAC; report the first month m that reaches it, or fail the gate if expected lifetime contribution never does |

No measurement method is approved by this proposal. Phase 0 may accept only a
combination that passes the dry run without a person-level campaign join, such
as platform aggregates, first-party aggregate landing counts, thresholded
geo/time holdouts, or clearly disclosed promo-code aggregates. If any required
gate, Plan-mix result, or reserve decision is not computable within the approved
privacy boundary, Lean does not launch.

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
professional traits such as job title, company, and industry. The Max Plan test
should use broad role and industry context, platform aggregates, and no
customer-list or sensitive targeting. See [LinkedIn reporting and
analytics](https://business.linkedin.com/en-us/marketing-solutions/reporting-analytics).

### Operating scorecard

| Metric | Evidence | Approved Phase 0 use | Use after matured measurement |
| --- | --- | --- | --- |
| Spend, clicks, and blended CPC | Observed fact | Platform aggregate | Platform aggregate |
| Click to completed Free | Planning assumption | Directional aggregate only | Cohort aggregate if approved |
| Cost per completed Free | Planning assumption | Directional aggregate only | Cohort aggregate if approved |
| Seven-day first-value activation | Planning assumption | Coarse cohort aggregate only if authorized | Coarse cohort aggregate if approved |
| Paid within 60 days | Planning assumption | Matured aggregate only if authorized | Matured cohort aggregate if approved |
| Pro and Max Plan mix | Planning assumption | Matured aggregate only if authorized | Matured cohort aggregate if approved |
| Referral starts | Planning assumption | Separate aggregate only if authorized | Exclude from paid acquisition results |
| Media CAC | Calculated output | Forecast only; do not claim as observed | Calculate only from approved aggregate cohorts |
| Campaign cash CAC | Calculated output | Forecast only; do not claim as observed | Calculate only from approved aggregate cohorts |
| Fully loaded contribution CAC and retention-aware payback | Calculated output | Unavailable | Calculate month-by-month recovery only after Finance approves the retention, lifetime, adjustment, and contribution inputs |

**Observed fact:** June ships a "Give a month, get a month" referral loop with
nudges after completed-value moments. Referral can lift total acquisition, but
it is organic upside. Do not credit referred paid Plan starts to paid media or
use them as evidence that paid acquisition economics passed.

## Experiment cadence and decision gates

### Cadence

| Period | Evidence | Required work |
| --- | --- | --- |
| Before week 1 | Planning assumption | Approve Phase 0, establish holdouts, freeze definitions, pass the full dry run, accept Lean caps, collect fresh named Growth, Finance, and privacy approval, and quality-check pages |
| Every active media day and before any release | Planning assumption | Verify every approved measurement source, cohort window, estimator, and scorecard output is available, uncontaminated, and still distinguishes paid cohorts from organic; latch the fail-closed pause on any failure |
| Lean weeks 1 to 2 | Planning assumption | Launch all three wedges at controlled bids, review search terms and placements twice weekly, and resolve brand or privacy issues immediately |
| Lean weeks 3 to 4 | Planning assumption | Stop failed cells, refresh one variable at a time, and compare wedge-level click-to-Free only where traffic is sufficient |
| Lean weeks 5 to 6 | Planning assumption | Hold winning cells stable, do not force the cap to spend, and prepare the initial readout |
| Days 1 to 60 after each completed Free cohort | Planning assumption | Let conversion mature before using the cohort in a Free-to-paid or campaign cash CAC gate |
| Growth and Scale | Planning assumption | Weekly operating review, fortnightly creative review, and a formal gate review only after the relevant cohort matures |

### Advancement gates

**Planning assumption:** Phase 0 pre-registers one conservative one-sided
uncertainty rule for every decision. Rate minimums must pass on the conservative
lower bound; cost and payback maximums must pass on the conservative upper
bound. Raw point estimates never authorize progression, and denominators,
windows, exclusions, or uncertainty methods cannot change after launch.

Move from Lean to Growth only when all of these are true:

- **Planning assumption:** The lower bound for click-to-completed-Free is at
  least 6%.
- **Planning assumption:** The upper bound for cost per completed Free is no
  more than $50.
- **Planning assumption:** Each compared wedge has enough paid traffic to
  support a directional comparison. Use 300 paid clicks per wedge as the
  minimum operating sample, not as a claim of statistical significance.
- **Planning assumption:** The lower bound for seven-day first-value activation
  is at least 25%, after at least 20 completed Free accounts mature for seven
  days.
- **Planning assumption:** No unresolved privacy, policy, or brand issue exists.
- **Planning assumption:** At least 10 net incremental paid Plan starts have
  matured through the 60-day and approved refund/cancellation windows. This is
  an operating minimum, not statistical proof.
- **Planning assumption:** The lower bound for matured 60-day Free-to-paid
  conversion is at least 8%.
- **Planning assumption:** The upper bound for campaign cash CAC is no more
  than $400. This requires the Lean test to outperform the 10-paid operating
  minimum within the $5,000 campaign cash cap.
- **Planning assumption:** Finance approves the fully loaded contribution
  inputs, and the conservative bound reaches cumulative expected contribution
  recovery no later than month 18. If expected lifetime contribution never
  recovers fully loaded contribution CAC, the gate fails.
- **Planning assumption:** After every condition above passes, Growth, Finance,
  and the privacy reviewer each give fresh named approval to release Growth
  tranche 1.

**Calculated output:** The Lean base scenario projects 4 paid Plan starts, 5%
60-day Free-to-paid, $1,250 campaign cash CAC, and 44.6 months campaign cash
gross-revenue payback. It therefore cannot unlock Growth even if its 6%
click-to-Free and $50 cost per completed Free meet the leading diagnostic
gates. The table's raw Upside point estimate also cannot authorize Growth;
every uncertainty and fully loaded contribution gate must pass on matured data.

### Intra-Growth release gate

Before releasing Growth tranches 2, 3, or 4, every condition below must pass:

- **Planning assumption:** The prior Growth tranche completed two active media
  weeks.
- **Planning assumption:** At least 80% of the prior tranche's $4,250 media
  cap, or $3,400, received valid exposure under the approved measurement
  contract.
- **Planning assumption:** Every completed Growth tranche completed two active
  media weeks and at least 80% of each tranche's $4,250 media cap, or $3,400,
  received valid exposure.
- **Planning assumption:** The prior tranche cohort and all cumulative Growth
  cohorts matured through their 60-day and approved refund/cancellation
  windows.
- **Planning assumption:** The latest tranche has at least 10 net incremental
  paid Plan starts, and cumulative Growth has at least `10 x number of completed
  Growth tranches` net incremental paid Plan starts.
- **Planning assumption:** For both the latest tranche independently and
  cumulative Growth, the lower bound for click-to-completed-Free is at least 6%
  and the upper bound for cost per completed Free is no more than $50.
- **Planning assumption:** For both scopes, each compared wedge has at least
  300 paid clicks.
- **Planning assumption:** For both scopes, the lower bound for seven-day
  first-value activation is at least 25%, after at least 20 completed Free
  accounts mature for seven days.
- **Planning assumption:** For both scopes, the lower bound for 60-day
  Free-to-paid conversion is at least 8%.
- **Planning assumption:** For both scopes, the upper bound for campaign cash
  CAC is no more than $400.
- **Planning assumption:** For both scopes, the conservative bound reaches
  retention-aware cumulative expected contribution recovery no later than
  month 18. If expected lifetime contribution never recovers fully loaded
  contribution CAC, the gate fails.
- **Planning assumption:** Fixed cell and cohort samples are met and every
  required measurement is computable for both scopes.
- **Planning assumption:** No unresolved privacy, policy, misleading-copy, or
  brand issue exists.
- **Planning assumption:** After all latest-tranche and cumulative Growth
  conditions above pass, Growth, Finance, and the privacy reviewer each give
  fresh named approval for this single Growth tranche release.

All conditions use the pre-registered conservative uncertainty rule. A stopped,
underexposed, suppressed, or unmeasurable latest or cumulative scope fails the
Intra-Growth release gate and cannot release the next tranche. No release may
change a campaign, tranche, reserve, cell, or geographic cap.

Move from Growth to Scale only when all of these are true:

- **Planning assumption:** All four Growth tranches and all eight active media
  weeks are complete.
- **Planning assumption:** Every Growth tranche delivered at least 80% of its
  released media cap. A tranche ended by a stop rule or otherwise underexposed
  cannot authorize Scale.
- **Planning assumption:** Every Growth tranche cohort has matured through its
  60-day and approved refund/cancellation windows.
- **Planning assumption:** At least 30 cumulative net incremental paid Plan
  starts have matured through those windows.
- **Planning assumption:** Both the latest Growth tranche independently and
  cumulative Growth pass every applicable gate under the pre-registered
  uncertainty rule and fully loaded contribution model.
- **Planning assumption:** For both scopes, the lower bound for 60-day
  Free-to-paid conversion is at least 8%.
- **Planning assumption:** For both scopes, the upper bound for campaign cash
  CAC is no more than $300 under the privacy-reviewed aggregate design.
- **Planning assumption:** For both scopes, Finance approves the fully loaded
  contribution inputs, and the conservative bound reaches cumulative expected
  contribution recovery no later than month 12. If expected lifetime
  contribution never recovers fully loaded contribution CAC, the gate fails.
- **Planning assumption:** For both scopes, the lower bound for Max Plan share
  is at least 10% of paid Plan starts, or Pro Plan economics pass independently
  without relying on Max Plan mix.
- **Planning assumption:** After every condition above passes, Growth, Finance,
  and the privacy reviewer each give fresh named approval to release Scale
  tranche 1.

### Intra-Scale release gate

Before releasing Scale tranches 2, 3, or 4, every condition below must pass:

- **Planning assumption:** The prior Scale tranche completed all three active
  media weeks.
- **Planning assumption:** At least 80% of the prior tranche's $13,500 media
  cap, or $10,800, received valid exposure under the approved measurement
  contract.
- **Planning assumption:** Every completed Scale tranche completed three active
  media weeks and at least 80% of each tranche's $13,500 media cap, or $10,800,
  received valid exposure.
- **Planning assumption:** The prior tranche cohort and all cumulative Scale
  cohorts matured through their 60-day and approved refund/cancellation
  windows.
- **Planning assumption:** The latest tranche has at least 30 net incremental
  paid Plan starts, and cumulative Scale has at least `30 x number of completed
  Scale tranches` net incremental paid Plan starts.
- **Planning assumption:** For both the latest tranche independently and
  cumulative Scale, the lower bound for 60-day Free-to-paid conversion is at
  least 8%.
- **Planning assumption:** For both scopes, the upper bound for campaign cash
  CAC is no more than $300.
- **Planning assumption:** For both scopes, the conservative bound reaches
  retention-aware cumulative expected contribution recovery no later than
  month 12. If expected lifetime contribution never recovers fully loaded
  contribution CAC, the gate fails.
- **Planning assumption:** For both scopes, the lower bound for Max Plan share
  is at least 10%, or Pro Plan economics pass independently without relying on
  Max Plan mix.
- **Planning assumption:** Fixed cell and cohort samples are met and every
  required measurement is computable for both scopes.
- **Planning assumption:** No unresolved privacy, policy, misleading-copy, or
  brand issue exists.
- **Planning assumption:** After all latest-tranche and cumulative Scale
  conditions above pass, Growth, Finance, and the privacy reviewer each give
  fresh named approval for this single Scale tranche release.

All conditions use the pre-registered conservative uncertainty rule. A stopped,
underexposed, suppressed, or unmeasurable latest or cumulative scope fails the
Intra-Scale release gate and cannot release the next tranche. No release may
change a campaign, tranche, reserve, cell, or geographic cap.

No reserved funds release automatically. Campaign-wide success never
authorizes a new cell. Every new Growth paid acquisition channel or geography
and every new Scale paid acquisition channel remains inside its explicit test
reserve. For Growth and Scale, a new cell has a maximum $1,000 seed budget,
released as two sequential $500 increments and drawn from the existing reserve,
not added to the campaign-tier cap. The seed derives from the frozen activation
sample and cost ceiling: `20 completed Free x $50 = $1,000`.

**Calculated output:** One fully seeded cell reduces the Growth new-cell test
reserve from $7,650 to $6,650 or the Scale new paid acquisition channel and
cell test reserve from $13,500 to $12,500. The campaign-tier media and campaign
cash caps do not change.

The first $500 is the pre-defined seed. It may release only after measurement
is computable, no stop, privacy, policy, misleading-copy, or brand issue exists,
and Growth, Finance, and the privacy reviewer each give fresh named approval for
that first seed. The second $500 may release only when measurement remains
computable, no stop, privacy, policy, misleading-copy, or brand issue exists,
the first seed did not reach the frozen sample, and Growth, Finance, and the
privacy reviewer each give fresh named approval for that second seed.

### Post-seed new-cell release increments

After the two $500 seed releases reach their cumulative $1,000 maximum, every
post-seed new-cell media release is a maximum $1,000 increment drawn from the
current tranche's existing reserve. It is not added to a campaign, tranche,
reserve, cell, or geographic cap. Treat the completed $1,000 seed as the prior
increment when evaluating the first post-seed release.

Before releasing the next increment, every condition below must pass:

- **Planning assumption:** At least 80% of the prior increment received valid
  exposure under the approved measurement contract.
- **Planning assumption:** The prior increment's cohort matured through its
  60-day and approved refund/cancellation windows.
- **Planning assumption:** Both the prior increment independently and the
  cumulative cell pass every frozen cell gate under the pre-registered
  conservative uncertainty rule.
- **Planning assumption:** Fixed cell and cohort samples are met. The lower
  bound for click-to-completed-Free is at least 6%, the upper bound for cost per
  completed Free is no more than $50, and every compared wedge has at least 300
  paid clicks.
- **Planning assumption:** The lower bound for seven-day first-value activation
  is at least 25% after at least 20 completed Free accounts mature for seven
  days, and the lower bound for 60-day Free-to-paid conversion is at least 8%.
- **Planning assumption:** The upper bound for campaign cash CAC meets the
  applicable campaign-tier ceiling: $400 in Growth or $300 in Scale.
- **Planning assumption:** The conservative bound reaches retention-aware
  cumulative expected contribution recovery by the applicable deadline: month
  18 in Growth or month 12 in Scale. Any applicable Plan-mix gate also passes.
- **Planning assumption:** Every required measurement is computable and no
  unresolved privacy, policy, misleading-copy, or brand issue exists.
- **Planning assumption:** Growth, Finance, and the privacy reviewer each
  re-approve this single increment.

A stopped, underexposed, suppressed, contaminated, or unmeasurable prior
increment or cumulative cell scope fails and cannot release more media. No
single approval releases multiple increments or the remaining reserve. Creative
variants stay nested within the cell; otherwise, its funds remain reserved.

### Stop and pause rules

- **Planning assumption:** Stop a wedge after 300 paid clicks if
  click-to-completed-Free remains below 3%.
- **Planning assumption:** Independently pause a paid acquisition channel cell
  after 300 paid clicks when cost per completed Free exceeds $100, regardless
  of downstream activation.
- **Planning assumption:** Separately pause a paid acquisition cell when fewer
  than 25% of at least 20 completed Free accounts complete the wedge's
  first-value job after each account has matured for seven days.
- **Planning assumption:** Any loss or contamination of an approved measurement
  source, cohort window, estimator, or required scorecard output, or any
  inability to distinguish paid cohorts from organic even when outputs still
  exist, immediately latches a pause on all active and scheduled media and all
  external campaign cash commitments across Lean, Growth, and Scale.
- **Planning assumption:** The latch remains until the privacy reviewer verifies
  measurement is restored and every affected cohort and window is reconciled.
- **Planning assumption:** Blind time does not count toward active media weeks
  or valid exposure. Blind media spend remains in the media CAC numerator.
  Blind media and external campaign cash spend remain in the campaign cash CAC
  numerator, and all blind spend remains in the applicable media and campaign
  cash caps.
- **Planning assumption:** If any affected cohort or window cannot be
  reconciled, the current tranche or campaign fails and cannot authorize a
  later tranche or campaign tier.
- **Planning assumption:** Pause immediately for a privacy, policy,
  misleading-copy, or brand issue. Diagnosis and review are required before
  restart.

## Dependencies, risks, and out of scope

| Item | Evidence | Risk or dependency | Required response |
| --- | --- | --- | --- |
| Attribution design | Observed fact | Current June P3A cannot measure the paid funnel | Complete separate Phase 0 privacy review before launch |
| Finance inputs | Observed fact | Retention-aware contribution recovery is unavailable | Finance supplies the monthly retention curve, expected lifetime, cancellations, refunds, promotions and credits, Plan-level contribution margin, and conservative recovery inputs |
| Sixty-day lag | Planning assumption | Early optimization can reward cheap accounts that never pay | Use leading diagnostics, but mature cohorts before campaign cash and contribution gates |
| Landing variants | Planning assumption | Organic guides may not match paid queries or disclose the right pricing context | Build one campaign-matched variant per wedge and preserve the source guides |
| Creative production | Planning assumption | June's agent breadth is difficult to explain in a cold static ad | Lead with one completed job and reserve breadth for the landing page or longer video |
| Referral loop | Observed fact | Referral lift can contaminate acquisition credit | Report referral separately and exclude it from all paid acquisition cost metrics |
| Small geographic cells | Planning assumption | Canada, UK, and Australia can be noisy | Keep Growth and Scale splits coarse and reallocate only on passing evidence |
| Platform optimization | Observed fact | Conversion products can pressure the team toward user-level tracking | Keep conversion optimization off until Phase 0 explicitly approves a design |
| Product readiness | Planning assumption | Paid traffic magnifies onboarding, permission, and first-value friction | Treat activation as a required leading diagnostic, not a marketing afterthought |

Out of scope:

- A product pricing, Free-limit, onboarding, or Plan change.
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
