export const STARTERS = [
    {
        slug: "trading-defi-agent",
        label: "trading-defi-agent",
        shortDescription: "Quote → validate → execute via price feeds + DEXes",
        policy: {
            name: "trading-defi-default",
            description: "Suggested policy for the trading-defi-agent starter.",
            spend_cap_usd: 50,
            cap_period_hours: 24,
            approval_required: true,
            approval_threshold_usd: 5,
        },
        recommendedFirst: true,
    },
    {
        slug: "research-agent",
        label: "research-agent",
        shortDescription: "Multi-source research agent that pays for gated data APIs",
        policy: {
            name: "research-default",
            description: "Suggested policy for the research-agent starter.",
            spend_cap_usd: 5,
            cap_period_hours: 24,
            approval_required: true,
            approval_threshold_usd: 0.5,
        },
    },
    {
        slug: "travel-agent",
        label: "travel-agent",
        shortDescription: "Search flights/airport schedules; surface options for human approval",
        policy: {
            name: "travel-default",
            description: "Suggested policy for the travel-agent starter.",
            spend_cap_usd: 5,
            cap_period_hours: 24,
            approval_required: true,
            approval_threshold_usd: 0.5,
        },
    },
    {
        slug: "lead-gen-agent",
        label: "lead-gen-agent",
        shortDescription: "Enrich and verify B2B contacts via per-lead paid APIs",
        policy: {
            name: "lead-gen-default",
            description: "Suggested policy for the lead-gen-agent starter.",
            spend_cap_usd: 25,
            cap_period_hours: 24,
            approval_required: true,
            approval_threshold_usd: 2,
        },
    },
    {
        slug: "content-creator-agent",
        label: "content-creator-agent",
        shortDescription: "Pay for stock assets + AI image/voice/video generation",
        policy: {
            name: "content-creator-default",
            description: "Suggested policy for the content-creator-agent starter.",
            spend_cap_usd: 20,
            cap_period_hours: 24,
            approval_required: true,
            approval_threshold_usd: 3,
        },
    },
    {
        slug: "treasury-billpay-agent",
        label: "treasury-billpay-agent",
        shortDescription: "Pay vendor invoices + recurring subs within budget; flag anomalies",
        policy: {
            name: "treasury-billpay-default",
            description: "Suggested policy for the treasury-billpay-agent starter.",
            spend_cap_usd: 200,
            cap_period_hours: 24,
            approval_required: true,
            approval_threshold_usd: 25,
        },
    },
];
export function getStarter(slug) {
    return STARTERS.find((s) => s.slug === slug);
}
