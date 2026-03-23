// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Shannon Helper MCP Server
 *
 * Stdio MCP server providing save_deliverable and generate_totp tools
 * for Shannon penetration testing agents.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileURLToPath } from 'node:url';
import { createSaveDeliverableHandler, SaveDeliverableInputSchema } from './tools/save-deliverable.js';
import { generateTotp, GenerateTotpInputSchema } from './tools/generate-totp.js';

export function createShannonHelperServer(targetDir: string): McpServer {
  const server = new McpServer({
    name: 'shannon-helper',
    version: '1.0.0',
  });

  server.registerTool(
    'save_deliverable',
    {
      description:
        'Saves deliverable files with automatic validation. Queue files must have {"vulnerabilities": [...]} structure.',
      inputSchema: SaveDeliverableInputSchema.shape,
    },
    createSaveDeliverableHandler(targetDir)
  );

  server.registerTool(
    'generate_totp',
    {
      description: 'Generates 6-digit TOTP code for authentication. Secret must be base32-encoded.',
      inputSchema: GenerateTotpInputSchema.shape,
    },
    generateTotp
  );

  return server;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const targetDirIndex = args.indexOf('--target-dir');
  const targetDir =
    targetDirIndex >= 0 && args[targetDirIndex + 1]
      ? args[targetDirIndex + 1]
      : process.cwd();

  const server = createShannonHelperServer(targetDir ?? process.cwd());
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error('Shannon helper MCP server failed:', error);
    process.exit(1);
  });
}

export * from './types/index.js';
