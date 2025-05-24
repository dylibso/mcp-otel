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
import { Context } from '@opentelemetry/api';
import { ToolSchema } from "@modelcontextprotocol/sdk/types.js";

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

interface ServerConnection {
  name: string;
  client: Client;
}

export class ClaudeAgent {
  private servers: ServerConnection[] = [];
  private anthropic: Anthropic;
  private messages: ChatMessage[] = [];
  private tracer: any;
  private toolServerMap: Map<string, ServerConnection> = new Map();
  private sessionTraceId: string | null = null;
  private sessionId: string | null = null;
  private sessionSpan: Span | null = null;
  private sessionContext: Context | null = null;
  private conversationHistory: Array<{input: string, output: string}> = [];

  constructor(anthropicApiKey: string) {
    this.anthropic = new Anthropic({
      apiKey: anthropicApiKey,
    });
  }

  async initialize() {
    const tracingSetup = await initializeTracing('mcp-agent-client', '1.0.0');
    this.tracer = tracingSetup.tracer;
  }

  async connect() {
    if (!this.tracer) {
      throw new Error('Tracer not initialized. Call initialize() first.');
    }
    
    // Generate a session ID that will be used to link all traces
    this.sessionId = `session-${Date.now()}`;
    
    // Create a persistent session span that will stay active throughout the chat session
    this.sessionSpan = this.tracer.startSpan('chat.session', 
      { attributes: { 
        'session.id': this.sessionId,
        'session.event': 'start',
        'gen_ai.system': 'anthropic',
        'conversation.turns': 0
      } }
    );
    
    // Create context with the active session span
    if (this.sessionSpan) {
      this.sessionContext = trace.setSpan(context.active(), this.sessionSpan);
    }
    
    // Now connect to servers within the session context
    if (!this.sessionContext) {
      throw new Error('Session context not created');
    }
    
    return context.with(this.sessionContext, () => 
      this.tracer.startActiveSpan('connect', 
        { attributes: { 
          'event': 'connection',
          'session.id': this.sessionId
        } },
        async (span: Span) => {
      try {
        const serversDir = join(__dirname, 'servers');
        const serverFiles = readdirSync(serversDir)
          .filter(file => file.endsWith('.js'))
          .filter(file => file !== 'index.js');

        for (const serverFile of serverFiles) {
          const serverName = serverFile.replace('.js', '');
          const args = [join(__dirname, 'servers', serverFile)];
          const transport = new StdioClientTransport({
            command: "node",
            args
          });

          const client = new Client({
            name: `claude-agent-${serverName}`,
            version: "1.0.0",
          });

          await client.connect(transport);
          
          this.servers.push({
            name: serverName,
            client
          });
          
          console.log(`Connected to ${serverName} server`);
        }

        console.log("Connected to all MCP servers");
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
    }));
  }

  async getMcpTools(): Promise<NonNullable<MessageCreateParams['tools']>> {
    if (!this.sessionContext) {
      throw new Error('Session context not initialized. Call connect() first.');
    }
    
    return context.with(this.sessionContext, () =>
      this.tracer.startActiveSpan('mcp.list_tools', 
        { attributes: { 'mcp.operation': 'list_tools' } },
        async (span: Span) => {
        try {
          const allTools: any[] = [];
          
          // Set input for tool discovery
          span.setAttribute('input.value', `Listing tools from ${this.servers.length} servers`);
          
          for (const server of this.servers) {
            const serverSpan = this.tracer.startSpan(`mcp.list_tools.${server.name}`, {
              parent: span,
              attributes: { 
                'mcp.server': server.name,
                'mcp.operation': 'list_tools'
              }
            });
            
            try {
              // Set input for this server
              serverSpan.setAttribute('input.value', `List tools from ${server.name}`);
              
              const tools = await server.client.listTools();
              const toolSchemas = tools.tools || [];
              
              // Set output for this server
              serverSpan.setAttribute('output.value', 
                `${toolSchemas.length} tools: ${toolSchemas.map((t: any) => t.name).join(', ')}`
              );
              
              serverSpan.setStatus({ code: SpanStatusCode.OK });
              
              allTools.push(...toolSchemas);
              toolSchemas.forEach((tool: any) => {
                this.toolServerMap.set(tool.name, server);
              });
            } catch (error) {
              serverSpan.setStatus({
                code: SpanStatusCode.ERROR,
                message: error instanceof Error ? error.message : 'Unknown error'
              });
              throw error;
            } finally {
              serverSpan.end();
            }
          }
          
          // Set output for overall tool discovery
          span.setAttribute('output.value', `Found ${allTools.length} tools: ${allTools.map(t => t.name).join(', ')}`);
          
          // Convert to Anthropic's expected format
          const result = allTools.map((tool: any) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema
          }));
          
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : 'Unknown error'
          });
          throw error;
        } finally {
          span.end();
        }
      })
    );
  }

  async handleToolUse(toolUse: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<string> {
    if (!this.sessionContext) {
      throw new Error('Session context not initialized. Call connect() first.');
    }
    
    return context.with(this.sessionContext, () =>
      this.tracer.startActiveSpan(`mcp_tool.${toolUse.name}`, 
        { 
          attributes: { 
            'tool.name': toolUse.name,
            'tool.id': toolUse.id,
            'tool.arguments': JSON.stringify(toolUse.arguments)
          } 
        },
        async (span: Span) => {
        try {
          // Set clean input for the tool call
          const toolInput = toolUse.name === 'calculate' 
            ? `${toolUse.arguments.operation}(${toolUse.arguments.a}, ${toolUse.arguments.b})`
            : toolUse.name === 'fetch'
            ? `Fetch: ${toolUse.arguments.url}`
            : JSON.stringify(toolUse.arguments);
          span.setAttribute('input.value', toolInput);
          
          const server = this.toolServerMap.get(toolUse.name);

          if (!server) {
            throw new Error(`No server found for tool: ${toolUse.name}`);
          }

          const traceContext = {
            traceId: span.spanContext().traceId,
            spanId: span.spanContext().spanId,
            traceFlags: span.spanContext().traceFlags,
            isRemote: false
          };

          const result = await server.client.callTool({
            name: toolUse.name,
            arguments: toolUse.arguments,
            _meta: { __traceContext: traceContext }
          });

          const resultContent = result.content as any[];
          const resultText = resultContent?.[0]?.type === 'text' 
            ? resultContent[0].text 
            : JSON.stringify(resultContent);

          // Set clean output for the tool result
          span.setAttribute('output.value', resultText);
          
          span.setStatus({ code: SpanStatusCode.OK });

          return resultText;
        } catch (error) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : 'Tool execution failed'
          });
          throw error;
        } finally {
          span.end();
        }
      })
    );
  }

  async chat(userMessage: string) {
    if (!this.sessionContext) {
      throw new Error('Session context not initialized. Call connect() first.');
    }
    
    return context.with(this.sessionContext, () =>
      this.tracer.startActiveSpan('chat.turn', 
        { attributes: { 
          'chat.message': userMessage,
          'gen_ai.system': 'anthropic',
          'session.id': this.sessionId || 'no-session'
        } },
        async (span: Span) => {
        try {
          // Set clean input value
          span.setAttribute('input.value', userMessage);
          
          this.messages.push({ role: 'user', content: [{ type: 'text', text: userMessage }] });

          const tools = await this.getMcpTools();

          const modelSpan = this.tracer.startSpan('chat.model_call', {
            parent: span,
            attributes: { 
              'chat.turn': this.messages.filter(m => m.role === 'user').length,
              'chat.messages': this.messages.length,
              'gen_ai.system': 'anthropic',
              'gen_ai.request.model': 'claude-3-5-sonnet-20241022'
            }
          });

          try {
            // Set input for model call
            modelSpan.setAttribute('input.value', `Turn ${this.messages.filter(m => m.role === 'user').length}: ${userMessage}`);
            
            const response = await this.anthropic.messages.create({
              model: 'claude-3-5-sonnet-20241022',
              max_tokens: 4096,
              messages: this.messages,
              tools
            });

            // Set output for model call
            modelSpan.setAttribute('output.value', `Response generated (${response.usage.output_tokens} tokens)`);
            
            // Add more GenAI semantic conventions
            modelSpan.setAttribute('gen_ai.response.model', response.model);
            modelSpan.setAttribute('gen_ai.usage.completion_tokens', response.usage.output_tokens);
            modelSpan.setAttribute('gen_ai.usage.prompt_tokens', response.usage.input_tokens);
            modelSpan.setAttribute('gen_ai.response.finish_reasons', [response.stop_reason]);
            
            modelSpan.setStatus({ code: SpanStatusCode.OK });

            const assistantContent: ContentBlockParam[] = [];
            let toolResults: ContentBlockParam[] = [];

            for (const block of response.content) {
              if (block.type === 'text') {
                assistantContent.push({ type: 'text', text: block.text });
              } else if (block.type === 'tool_use') {
                const toolResult = await this.handleToolUse({
                  id: block.id,
                  name: block.name,
                  arguments: block.input as Record<string, unknown>
                });

                assistantContent.push({
                  type: 'tool_use',
                  id: block.id,
                  name: block.name,
                  input: block.input
                });

                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: block.id,
                  content: toolResult
                });
              }
            }

            // Add the assistant message with all content (text + tool uses)
            this.messages.push({ role: 'assistant', content: assistantContent });

            // If there were tool uses, add tool results and continue processing
            let currentResponse = response;
            while (toolResults.length > 0) {
              // Send the current tool results
              this.messages.push({
                role: 'user',
                content: toolResults
              });

              const continuationResponse = await this.anthropic.messages.create({
                model: 'claude-3-5-sonnet-20241022',
                max_tokens: 4096,
                messages: this.messages,
                tools
              });

              // Create a new array for the next iteration's tool results
              const newToolResults: ContentBlockParam[] = [];
              const continuationContent: ContentBlockParam[] = [];

              // Process the continuation response
              for (const block of continuationResponse.content) {
                if (block.type === 'text') {
                  continuationContent.push({ type: 'text', text: block.text });
                } else if (block.type === 'tool_use') {
                  const toolResult = await this.handleToolUse({
                    id: block.id,
                    name: block.name,
                    arguments: block.input as Record<string, unknown>
                  });

                  continuationContent.push({
                    type: 'tool_use',
                    id: block.id,
                    name: block.name,
                    input: block.input
                  });

                  newToolResults.push({
                    type: 'tool_result',
                    tool_use_id: block.id,
                    content: toolResult
                  });
                }
              }

              this.messages.push({
                role: 'assistant',
                content: continuationContent
              });

              currentResponse = continuationResponse;
              toolResults = newToolResults;

              // If no more tool uses, we're done
              if (toolResults.length === 0) {
                break;
              }
            }

            // Extract clean output text
            let outputText = '';
            for (const block of currentResponse.content) {
              if (block.type === 'text') {
                outputText += block.text;
              }
            }
            
            // Set clean output value
            span.setAttribute('output.value', outputText);
            
            // Track conversation history
            this.conversationHistory.push({ input: userMessage, output: outputText });
            
            // Update session span with conversation history
            if (this.sessionSpan) {
              this.sessionSpan.setAttribute('conversation.turns', this.conversationHistory.length);
              
              // Build a proper conversation transcript
              const conversationTranscript = this.conversationHistory.map((turn, i) => 
                `[Turn ${i+1}]\nUser: ${turn.input}\nAssistant: ${turn.output}`
              ).join('\n\n');
              
              // Set the full conversation as both input and output for easy viewing
              this.sessionSpan.setAttribute('input.value', conversationTranscript);
              this.sessionSpan.setAttribute('output.value', conversationTranscript);
              
              // Also keep a summary
              this.sessionSpan.setAttribute('conversation.summary', 
                `${this.conversationHistory.length} turns - Latest: "${this.conversationHistory[this.conversationHistory.length - 1].input}"`
              );
            }
            
            span.setStatus({ code: SpanStatusCode.OK });
            return currentResponse;
          } catch (error) {
            modelSpan.setStatus({
              code: SpanStatusCode.ERROR,
              message: error instanceof Error ? error.message : 'Model call failed'
            });
            throw error;
          } finally {
            modelSpan.end();
          }
        } catch (error) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : 'Chat turn failed'
          });
          throw error;
        } finally {
          span.end();
        }
      })
    );
  }

  async cleanup() {
    return this.tracer.startActiveSpan('cleanup', 
      { attributes: { 
        'event': 'cleanup',
        'session.id': this.sessionId || 'no-session'
      } },
      async (span: Span) => {
      try {
        for (const server of this.servers) {
          await server.client.close();
        }
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : 'Cleanup failed'
        });
        throw error;
      } finally {
        span.end();
        
        // End the persistent session span
        if (this.sessionSpan) {
          this.sessionSpan.setAttribute('session.event', 'end');
          this.sessionSpan.setStatus({ code: SpanStatusCode.OK });
          this.sessionSpan.end();
          this.sessionSpan = null;
          this.sessionContext = null;
        }
      }
    });
  }
}
