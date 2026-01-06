import type { DuckDuckGoSearchParams, DuckDuckGoSearchResponse } from '@/tools/duckduckgo/types'
import type { ToolConfig } from '@/tools/types'

export const searchTool: ToolConfig<DuckDuckGoSearchParams, DuckDuckGoSearchResponse> = {
  id: 'duckduckgo_search',
  name: 'DuckDuckGo Search',
  description:
    'Search the web using DuckDuckGo Instant Answers API. Returns instant answers, abstracts, and related topics for your query. Free to use without an API key.',
  version: '1.0.0',

  params: {
    query: {
      type: 'string',
      required: true,
      visibility: 'user-or-llm',
      description: 'The search query to execute',
    },
    noHtml: {
      type: 'boolean',
      required: false,
      visibility: 'user-only',
      description: 'Remove HTML from text in results (default: true)',
    },
    skipDisambig: {
      type: 'boolean',
      required: false,
      visibility: 'user-only',
      description: 'Skip disambiguation results (default: false)',
    },
  },

  request: {
    url: (params) => {
      const baseUrl = 'https://api.duckduckgo.com/'
      const searchParams = new URLSearchParams({
        q: params.query,
        format: 'json',
        no_html: params.noHtml !== false ? '1' : '0',
        skip_disambig: params.skipDisambig ? '1' : '0',
      })
      return `${baseUrl}?${searchParams.toString()}`
    },
    method: 'GET',
    headers: () => ({
      Accept: 'application/json',
    }),
  },

  transformResponse: async (response: Response) => {
    const data = await response.json()

    // Helper to map a single topic
    const mapTopic = (topic: any) => ({
      FirstURL: topic.FirstURL || '',
      Text: topic.Text || '',
      Result: topic.Result || '',
      Icon: topic.Icon
        ? {
            URL: topic.Icon.URL || '',
            Height: topic.Icon.Height || '',
            Width: topic.Icon.Width || '',
          }
        : undefined,
    })

    // Map related topics - handle both flat topics and nested category groups
    const relatedTopics: any[] = []
    for (const item of data.RelatedTopics || []) {
      if (item.Topics && Array.isArray(item.Topics)) {
        // This is a category group (e.g., "Art, entertainment, and media")
        for (const nestedTopic of item.Topics) {
          if (nestedTopic.FirstURL) {
            relatedTopics.push({
              ...mapTopic(nestedTopic),
              Category: item.Name || '',
            })
          }
        }
      } else if (item.FirstURL) {
        // This is a flat topic
        relatedTopics.push(mapTopic(item))
      }
    }

    // Map results (external links)
    const results = (data.Results || []).map((result: any) => mapTopic(result))

    // Build abstract - use the first related topic's text if abstract is empty (disambiguation)
    let abstract = data.Abstract || ''
    let abstractText = data.AbstractText || ''
    
    // For disambiguation queries (Type: D), create a summary from related topics
    if (!abstract && data.Type === 'D' && relatedTopics.length > 0) {
      const topTopics = relatedTopics.slice(0, 5)
      abstract = `Multiple meanings found for "${data.Heading}": ` + 
        topTopics.map(t => t.Text.split(' ').slice(0, 10).join(' ')).join('; ')
      abstractText = abstract
    }

    return {
      success: true,
      output: {
        heading: data.Heading || '',
        abstract,
        abstractText,
        abstractSource: data.AbstractSource || '',
        abstractURL: data.AbstractURL || '',
        image: data.Image || '',
        answer: data.Answer || '',
        answerType: data.AnswerType || '',
        type: data.Type || '',
        relatedTopics,
        results,
      },
    }
  },

  outputs: {
    heading: {
      type: 'string',
      description: 'The heading/title of the instant answer',
    },
    abstract: {
      type: 'string',
      description: 'A short abstract summary of the topic',
    },
    abstractText: {
      type: 'string',
      description: 'Plain text version of the abstract',
    },
    abstractSource: {
      type: 'string',
      description: 'The source of the abstract (e.g., Wikipedia)',
    },
    abstractURL: {
      type: 'string',
      description: 'URL to the source of the abstract',
    },
    image: {
      type: 'string',
      description: 'URL to an image related to the topic',
    },
    answer: {
      type: 'string',
      description: 'Direct answer if available (e.g., for calculations)',
    },
    answerType: {
      type: 'string',
      description: 'Type of the answer (e.g., calc, ip, etc.)',
    },
    type: {
      type: 'string',
      description:
        'Response type: A (article), D (disambiguation), C (category), N (name), E (exclusive)',
    },
    relatedTopics: {
      type: 'array',
      description: 'Array of related topics with URLs and descriptions',
      items: {
        type: 'object',
        properties: {
          FirstURL: { type: 'string', description: 'URL to the related topic' },
          Text: { type: 'string', description: 'Description of the related topic' },
          Result: { type: 'string', description: 'HTML result snippet' },
        },
      },
    },
    results: {
      type: 'array',
      description: 'Array of external link results',
      items: {
        type: 'object',
        properties: {
          FirstURL: { type: 'string', description: 'URL of the result' },
          Text: { type: 'string', description: 'Description of the result' },
          Result: { type: 'string', description: 'HTML result snippet' },
        },
      },
    },
  },
}
