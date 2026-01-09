export async function GET() {
  const llmsContent = `# AgentBuilder - AI Agent Workflow Builder
AgentBuilder is an open-source AI agent workflow builder for production workflows. Developers at trail-blazing startups to Fortune 500 companies deploy agentic workflows on the AgentBuilder platform. 60,000+ developers already use AgentBuilder to build and ship AI automations with 100+ integrations. AgentBuilder is SOC2 and HIPAA compliant and is designed for secure, enterprise-grade AI automation.

Website: https://ethana.ai
App: https://ethana.ai/workspace
Docs: https://docs.ethana.ai
GitHub: https://github.com/
Region: global
Primary language: en

## Capabilities
- Visual workflow builder for multi-step AI agents and tools
- Orchestration of LLM calls, tools, webhooks, and external APIs
- Scheduled and event-driven agent executions
- First-class support for retrieval-augmented generation (RAG)
- Multi-tenant, workspace-based access model

## Ideal Use Cases
- AI agent workflow automation
- RAG agents and retrieval pipelines
- Chatbot and copilot workflows for SaaS products
- Document and email processing workflows
- Customer support, marketing, and growth automations
- Internal operations automations (ops, finance, legal, sales)

## Key Entities
- Workspace: container for workflows, data sources, and executions
- Workflow: directed graph of blocks defining an agentic process
- Block: individual step (LLM call, tool call, HTTP request, code, etc.)
- Schedule: time-based trigger for running workflows
- Execution: a single run of a workflow

## Getting Started
- Quickstart: https://docs.ethana.ai/quickstart
- Product overview: https://docs.ethana.ai
- Source code: https://github.com/

## Safety & Reliability
- SOC2 and HIPAA aligned security controls
- Audit-friendly execution logs and cost tracking
- Fine-grained control over external tools, APIs, and data sources
`;

  return new Response(llmsContent, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
