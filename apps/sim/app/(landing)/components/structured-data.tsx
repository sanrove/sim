export default function StructuredData() {
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": "https://ethana.ai/#organization",
        name: "Ethana",
        alternateName: "Ethana Agent Builder",
        description:
          "Open-source AI agent workflow builder used by developers at trail-blazing startups to Fortune 500 companies",
        url: "https://ethana.ai",
        logo: {
          "@type": "ImageObject",
          "@id": "https://ethana.ai/#logo",
          url: "https://ethana.ai/logo/b&w/text/b&w.svg",
          contentUrl: "https://ethana.ai/logo/b&w/text/b&w.svg",
          width: 49.78314,
          height: 24.276,
          caption: "Ethana Logo",
        },
        image: { "@id": "https://ethana.ai/#logo" },
        sameAs: [
          "https://x.com/google",
          "https://github.com/",
          "https://www.linkedin.com/company/ethana-ai/",
          "https://discord.com",
        ],
        contactPoint: {
          "@type": "ContactPoint",
          contactType: "customer support",
          availableLanguage: ["en"],
        },
      },
      {
        "@type": "WebSite",
        "@id": "https://ethana.ai/#website",
        url: "https://ethana.ai",
        name: "Ethana - AI Agent Workflow Builder",
        description:
          "Open-source AI agent workflow builder. 60,000+ developers build and deploy agentic workflows. SOC2 and HIPAA compliant.",
        publisher: {
          "@id": "https://ethana.ai/#organization",
        },
        potentialAction: [
          {
            "@type": "SearchAction",
            "@id": "https://ethana.ai/#searchaction",
            target: {
              "@type": "EntryPoint",
              urlTemplate: "https://ethana.ai/search?q={search_term_string}",
            },
            "query-input": "required name=search_term_string",
          },
        ],
        inLanguage: "en-US",
      },
      {
        "@type": "WebPage",
        "@id": "https://ethana.ai/#webpage",
        url: "https://ethana.ai",
        name: "Ethana - Agent Builder | Build AI Agent Workflows",
        isPartOf: {
          "@id": "https://ethana.ai/#website",
        },
        about: {
          "@id": "https://ethana.ai/#software",
        },
        datePublished: "2024-01-01T00:00:00+00:00",
        dateModified: new Date().toISOString(),
        description:
          "Build and deploy AI agent workflows with Ethana. Visual drag-and-drop interface for creating powerful LLM-powered automations.",
        breadcrumb: {
          "@id": "https://ethana.ai/#breadcrumb",
        },
        inLanguage: "en-US",
        potentialAction: [
          {
            "@type": "ReadAction",
            target: ["https://ethana.ai"],
          },
        ],
      },
      {
        "@type": "BreadcrumbList",
        "@id": "https://ethana.ai/#breadcrumb",
        itemListElement: [
          {
            "@type": "ListItem",
            position: 1,
            name: "Home",
            item: "https://ethana.ai",
          },
        ],
      },
      {
        "@type": "SoftwareApplication",
        "@id": "https://ethana.ai/#software",
        name: "Ethana - AI Agent Workflow Builder",
        description:
          "Open-source AI agent workflow builder used by 60,000+ developers. Build agentic workflows with visual drag-and-drop interface. SOC2 and HIPAA compliant. Integrate with 100+ apps.",
        applicationCategory: "DeveloperApplication",
        applicationSubCategory: "AI Development Tools",
        operatingSystem: "Web, Windows, macOS, Linux",
        softwareVersion: "1.0",
        offers: [
          {
            "@type": "Offer",
            "@id": "https://ethana.ai/#offer-free",
            name: "Community Plan",
            price: "0",
            priceCurrency: "USD",
            priceValidUntil: "2025-12-31",
            itemCondition: "https://schema.org/NewCondition",
            availability: "https://schema.org/InStock",
            seller: {
              "@id": "https://ethana.ai/#organization",
            },
            eligibleRegion: {
              "@type": "Place",
              name: "Worldwide",
            },
          },
          {
            "@type": "Offer",
            "@id": "https://ethana.ai/#offer-pro",
            name: "Pro Plan",
            price: "20",
            priceCurrency: "USD",
            priceSpecification: {
              "@type": "UnitPriceSpecification",
              price: "20",
              priceCurrency: "USD",
              unitText: "MONTH",
              billingIncrement: 1,
            },
            priceValidUntil: "2025-12-31",
            itemCondition: "https://schema.org/NewCondition",
            availability: "https://schema.org/InStock",
            seller: {
              "@id": "https://ethana.ai/#organization",
            },
          },
          {
            "@type": "Offer",
            "@id": "https://ethana.ai/#offer-team",
            name: "Team Plan",
            price: "40",
            priceCurrency: "USD",
            priceSpecification: {
              "@type": "UnitPriceSpecification",
              price: "40",
              priceCurrency: "USD",
              unitText: "MONTH",
              billingIncrement: 1,
            },
            priceValidUntil: "2025-12-31",
            itemCondition: "https://schema.org/NewCondition",
            availability: "https://schema.org/InStock",
            seller: {
              "@id": "https://ethana.ai/#organization",
            },
          },
        ],
        aggregateRating: {
          "@type": "AggregateRating",
          ratingValue: "4.8",
          reviewCount: "150",
          bestRating: "5",
          worstRating: "1",
        },
        featureList: [
          "Visual workflow builder",
          "Drag-and-drop interface",
          "100+ integrations",
          "AI model support (OpenAI, Anthropic, Google, xAI, Mistral, Perplexity)",
          "Real-time collaboration",
          "Version control",
          "API access",
          "Custom functions",
          "Scheduled workflows",
          "Event triggers",
        ],
        screenshot: [
          {
            "@type": "ImageObject",
            url: "https://ethana.ai/screenshots/workflow-builder.png",
            caption: "Ethana workflow builder interface",
          },
        ],
      },
    ],
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      {/* LLM-friendly semantic HTML comments */}
      {/* About: Ethana is a visual workflow builder for AI agents and large language models (LLMs) */}
      {/* Purpose: Enable users to create AI-powered automations without coding */}
      {/* Features: Drag-and-drop interface, 100+ integrations, multi-model support */}
      {/* Use cases: Email automation, chatbots, data analysis, content generation */}
    </>
  );
}
