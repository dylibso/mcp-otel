import readline from 'readline';
import { ClaudeAgent } from './agent.js';
import type { Message, ContentBlock } from '@anthropic-ai/sdk/resources/messages';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

let isClosing = false;
let agent: ClaudeAgent | null = null;

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Please set ANTHROPIC_API_KEY environment variable');
    process.exit(1);
  }

  agent = new ClaudeAgent(apiKey);
  
  try {
    await agent.initialize();  
    await agent.connect();
    console.log('Connected to all MCP servers');
  } catch (error) {
    console.error('Failed to connect to MCP servers:', error);
    process.exit(1);
  }

  console.log('(Press Ctrl+C to exit)\n');

  function prompt() {
    if (isClosing) return;
    
    rl.question('You: ', async (input) => {
      if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
        await cleanup();
        return;
      }

      try {
        const result = await agent!.chat(input);
        if (!result) {
          console.log('No response from assistant');
          prompt();
          return;
        }

        const response = result as Message;
        const content = response.content as ContentBlock[];
        
        for (const block of content) {
          if (block.type === 'text' && 'text' in block) {
            console.log('\nAssistant:', block.text);
          }
        }
        console.log();
        prompt();
      } catch (error) {
        console.error('Error:', error);
        prompt();
      }
    });
  }

  prompt();
}

async function cleanup() {
  if (isClosing) return;
  isClosing = true;
  console.log('\nCleaning up...');
  
  // Clean up the agent to end the session span
  if (agent) {
    try {
      await agent.cleanup();
      console.log('Agent cleaned up successfully');
    } catch (error) {
      console.error('Error cleaning up agent:', error);
    }
  }
  
  rl.close();
  
  // Wait a bit for traces to be sent
  setTimeout(() => {
    process.exit(0);
  }, 1000);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// Start the application
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});