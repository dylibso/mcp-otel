import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Anthropic } from "@anthropic-ai/sdk";
import type {
  MessageCreateParams,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlockParam,
  ContentBlockParam
} from '@anthropic-ai/sdk/resources/messages';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readdirSync } from 'fs';
import { initializeTracing, SpanStatusCode, type Span, trace, context } from './tracing.js';
import { ToolSchema } from "@modelcontextprotocol/sdk/types.js";

const { tracer: clientTracer } = initializeTracing('mcp-agent-client', '1.0.0');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type ChatMessage = {
  role: 'user' | 'assistant';
  content: ContentBlockParam[];
};

interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export class ClaudeAgent {
  private client: Client;
  private anthropic: Anthropic;
  private messages: ChatMessage[] = [];

  constructor(anthropicApiKey: string) {
    this.anthropic = new Anthropic({
      apiKey: anthropicApiKey,
    });

    this.client = new Client({
      name: "claude-agent",
      version: "1.0.0",
    });
  }

  async connect() {
    return clientTracer.startActiveSpan('connect', 
      { attributes: { 'event': 'connection' } },
      context.active(),
      async (span: Span) => {
      try {
        const serversDir = join(__dirname, 'servers');
        const serverFiles = readdirSync(serversDir)
          .filter(file => file.endsWith('.js'))
          .filter(file => file !== 'index.js');

        for (const serverFile of serverFiles) {
          const args = [join(__dirname, 'servers', serverFile)];
          const transport = new StdioClientTransport({
            command: "node",
            args
          });

          await this.client.connect(transport);
        }

        console.log("Connected to MCP servers");
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : 'Connection failed'
        });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  private async getMcpTools(): Promise<NonNullable<MessageCreateParams['tools']>> {
    const toolsResult = await this.client.listTools();
    if (!toolsResult.tools) throw new Error(`no tools detected`)

    return toolsResult.tools.map((tool: any) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema
    }));
  }

  private async handleToolUse(toolUse: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<string> {
    return clientTracer.startActiveSpan(`tool.${toolUse.name}`, 
      { 
        attributes: {
          'tool.name': toolUse.name,
          'tool.id': toolUse.id,
          'tool.arguments': JSON.stringify(toolUse.arguments)
        }
      },
      context.active(),
      async (span: Span) => {
      try {
        console.log('\nExecuting tool:', toolUse.name);
        console.log('Tool arguments:', JSON.stringify(toolUse.arguments, null, 2));

        span.setAttribute('tool.name', toolUse.name);
        span.setAttribute('tool.id', toolUse.id);
        span.setAttribute('tool.arguments', JSON.stringify(toolUse.arguments));

        const result = await this.client.callTool({
          name: toolUse.name,
          arguments: toolUse.arguments,
          // Here we are *creatively reusing* the _meta property
          // to transport the trace context across
          _meta: {
            __traceContext: {
              traceId: span.spanContext().traceId,
              spanId: span.spanContext().spanId,
              traceFlags: span.spanContext().traceFlags,
              isRemote: true
            }
          }
        });

        let resultText = '';
        if (Array.isArray(result.content)) {
          resultText = result.content
            .filter(block => block.type === 'text')
            .map(block => block.text)
            .join('\n');
        }

        span.setAttribute('tool.result', resultText);
        span.setStatus({ code: SpanStatusCode.OK });

        return resultText;
      } catch (error) {
        console.error('Tool call failed:', error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : 'Tool execution failed'
        });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async chat(userMessage: string) {
    return clientTracer.startActiveSpan('chat.turn', async (parentSpan: Span) => {
      const parentCtx = trace.setSpan(context.active(), parentSpan);
      
      try {
        console.log('\n--- Starting chat turn ---');
        
        parentSpan.setAttribute('user.message', userMessage);
        parentSpan.setAttribute('message.turn', this.messages.length);

        this.messages.push({
          role: 'user',
          content: [{
            type: 'text',
            text: userMessage,
            citations: []
          }]
        });

        let shouldContinue = true;
        let finalResponse;
        let messageIdx = this.messages.length;
        let turnCount = 0;

        while (shouldContinue) {
          await clientTracer.startActiveSpan('chat.model_call', 
            { attributes: { 'chat.turn_number': turnCount + 1 } },
            parentCtx,
            async (modelSpan: Span) => {
            try {
              turnCount++;
              modelSpan.setAttribute('chat.turn_number', turnCount);

              const response = await this.anthropic.messages.create({
                model: "claude-3-7-sonnet-latest",
                max_tokens: 4096,
                messages: this.messages,
                tools: await this.getMcpTools(),
                system: "You are an AI assistant with access to tool calling capabilities via MCP."
              });

              if (response.stop_reason) {
                modelSpan.setAttribute('model.stop_reason', response.stop_reason);
              }
              modelSpan.setAttribute('model.usage.input_tokens', response.usage?.input_tokens || 0);
              modelSpan.setAttribute('model.usage.output_tokens', response.usage?.output_tokens || 0);

              console.log('Response stop reason:', response.stop_reason);

              this.messages.push({
                role: response.role,
                content: response.content
              });

              let userMessage: ChatMessage = {
                role: 'user',
                content: []
              };
              this.messages.push(userMessage);

              let hasToolCalls = false;
              for (const block of response.content) {
                if (block.type === 'tool_use') {
                  hasToolCalls = true;
                  modelSpan.setAttribute('has_tool_calls', true);
                  
                  const toolResult = await this.handleToolUse({
                    id: block.id || '',
                    name: block.name,
                    arguments: block.input as Record<string, unknown>
                  });

                  userMessage.content.push({
                    type: 'tool_result',
                    tool_use_id: block.id || '',
                    content: toolResult
                  });
                }
              }

              if (!hasToolCalls) {
                this.messages.pop();
                shouldContinue = false;
                finalResponse = response;
              }
              else if (response.stop_reason === 'end_turn') {
                shouldContinue = false;
                finalResponse = response;
              }
              
              messageIdx = this.messages.length;
              modelSpan.setStatus({ code: SpanStatusCode.OK });
            } catch (error) {
              modelSpan.setStatus({
                code: SpanStatusCode.ERROR,
                message: error instanceof Error ? error.message : 'Model call failed'
              });
              throw error;
            } finally {
              modelSpan.end();
            }
          });
        }

        console.log('--- Finished chat turn ---\n');
        
        parentSpan.setAttribute('chat.total_turns', turnCount);
        parentSpan.setAttribute('chat.message_count', this.messages.length);
        parentSpan.setStatus({ code: SpanStatusCode.OK });

        console.log(`Trace: http://localhost:8080/trace/${parentSpan.spanContext().traceId}`)
        
        return finalResponse;
      } catch (error) {
        parentSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : 'Chat turn failed'
        });
        throw error;
      } finally {
        parentSpan.end();
      }
    });
  }

  async cleanup() {
    return clientTracer.startActiveSpan('cleanup', 
      { attributes: { 'event': 'cleanup' } },
      context.active(),
      async (span: Span) => {
      try {
        await this.client.close();
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : 'Cleanup failed'
        });
        throw error;
      } finally {
        span.end();
      }
    });
  }
}
