import { z } from "zod";

const requiredText = z.string().trim().min(1);

export const messageDirectionSchema = z.enum(["inbound", "outbound"]);
export const messageStatusSchema = z.enum([
  "received",
  "processing",
  "sent",
  "failed"
]);
export const processingJobStatusSchema = z.enum([
  "queued",
  "processing",
  "completed",
  "failed"
]);

export const twilioSmsWebhookSchema = z.object({
  MessageSid: requiredText,
  From: requiredText,
  To: requiredText,
  Body: z.string().default("")
});

export const twilioMessageStatusCallbackSchema = z
  .object({
    MessageSid: requiredText,
    MessageStatus: requiredText.optional(),
    SmsStatus: requiredText.optional(),
    ErrorCode: z.string().optional(),
    ErrorMessage: z.string().optional()
  })
  .passthrough()
  .refine((input) => input.MessageStatus || input.SmsStatus, {
    message: "MessageStatus or SmsStatus is required"
  });

export const sendOutboundSmsRequestSchema = z.object({
  to: requiredText,
  body: z.string().min(1),
  idempotencyKey: z.string().trim().min(1).optional()
});

export const sendOutboundSmsResponseSchema = z.object({
  status: z.enum(["processing", "sent", "failed"]),
  conversationId: z.string(),
  outboundMessageId: z.string(),
  providerMessageId: z.string().nullable(),
  error: z.string().nullable()
});

export const conversationListItemSchema = z.object({
  id: z.string(),
  fromPhone: z.string(),
  toPhone: z.string(),
  lastMessageBody: z.string().nullable(),
  lastMessageAt: z.string().nullable(),
  lastMessageDirection: messageDirectionSchema.nullable(),
  lastMessageStatus: messageStatusSchema.nullable(),
  messageCount: z.number().int().nonnegative(),
  updatedAt: z.string()
});

export const messageProcessingJobSchema = z.object({
  status: processingJobStatusSchema,
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  lastError: z.string().nullable()
});

export const messageDtoSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  direction: messageDirectionSchema,
  status: messageStatusSchema,
  body: z.string(),
  processingJob: messageProcessingJobSchema.nullable(),
  providerMessageId: z.string().nullable(),
  twilioMessageSid: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  sentAt: z.string().nullable(),
  failedAt: z.string().nullable()
});

export const conversationMessagesResponseSchema = z.object({
  conversation: z.object({
    id: z.string(),
    fromPhone: z.string(),
    toPhone: z.string(),
    createdAt: z.string(),
    updatedAt: z.string()
  }),
  messages: z.array(messageDtoSchema)
});

export type MessageDirection = z.infer<typeof messageDirectionSchema>;
export type MessageStatus = z.infer<typeof messageStatusSchema>;
export type MessageProcessingJob = z.infer<typeof messageProcessingJobSchema>;
export type ProcessingJobStatus = z.infer<typeof processingJobStatusSchema>;
export type TwilioSmsWebhookPayload = z.infer<typeof twilioSmsWebhookSchema>;
export type TwilioMessageStatusCallback = z.infer<
  typeof twilioMessageStatusCallbackSchema
>;
export type SendOutboundSmsRequest = z.infer<
  typeof sendOutboundSmsRequestSchema
>;
export type SendOutboundSmsResponse = z.infer<
  typeof sendOutboundSmsResponseSchema
>;
export type ConversationListItem = z.infer<typeof conversationListItemSchema>;
export type MessageDto = z.infer<typeof messageDtoSchema>;
export type ConversationMessagesResponse = z.infer<
  typeof conversationMessagesResponseSchema
>;
