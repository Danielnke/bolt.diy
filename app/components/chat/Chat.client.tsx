/*
 * @ts-nocheck
 * Preventing TS checks with files presented in the video for a better presentation.
 */
import { useStore } from '@nanostores/react';
import type { Message } from 'ai';
import { useChat } from 'ai/react';
import { useAnimate } from 'framer-motion';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { cssTransition, toast, ToastContainer } from 'react-toastify';
import { useMessageParser, usePromptEnhancer, useShortcuts, useSnapScroll } from '~/lib/hooks';
import { description, useChatHistory } from '~/lib/persistence';
import { chatStore } from '~/lib/stores/chat';
import { workbenchStore } from '~/lib/stores/workbench';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, PROMPT_COOKIE_KEY, PROVIDER_LIST } from '~/utils/constants';
import { cubicEasingFn } from '~/utils/easings';
import { createScopedLogger, renderLogger } from '~/utils/logger';
import { BaseChat } from './BaseChat';
import Cookies from 'js-cookie';
import { debounce } from '~/utils/debounce';
import { useSettings } from '~/lib/hooks/useSettings';
import type { ProviderInfo } from '~/types/model';
import { useSearchParams } from '@remix-run/react';
import { createSampler } from '~/utils/sampler';
import { getTemplates, selectStarterTemplate } from '~/utils/selectStarterTemplate';
import { logStore } from '~/lib/stores/logs';
import { streamingState } from '~/lib/stores/streaming';
import { filesToArtifacts } from '~/utils/fileUtils'; // Ensure this import is correct

const toastAnimation = cssTransition({
  enter: 'animated fadeInRight',
  exit: 'animated fadeOutRight',
});

const logger = createScopedLogger('Chat');

export function Chat() {
  renderLogger.trace('Chat');

  const { ready, initialMessages, storeMessageHistory, importChat, exportChat } = useChatHistory();
  const title = useStore(description);
  useEffect(() => {
    workbenchStore.setReloadedMessages(initialMessages.map((m) => m.id));
  }, [initialMessages]);

  return (
    <>
      {ready && (
        <ChatImpl
          description={title}
          initialMessages={initialMessages}
          exportChat={exportChat}
          storeMessageHistory={storeMessageHistory}
          importChat={importChat}
        />
      )}
      <ToastContainer
        closeButton={({ closeToast }) => {
          return (
            <button className="Toastify__close-button" onClick={closeToast}>
              <div className="i-ph:x text-lg" />
            </button>
          );
        }}
        icon={({ type }) => {
          /**
           * @todo Handle more types if we need them. This may require extra color palettes.
           */
          switch (type) {
            case 'success': {
              return <div className="i-ph:check-bold text-bolt-elements-icon-success text-2xl" />;
            }
            case 'error': {
              return <div className="i-ph:warning-circle-bold text-bolt-elements-icon-error text-2xl" />;
            }
          }

          return undefined;
        }}
        position="bottom-right"
        pauseOnFocusLoss
        transition={toastAnimation}
      />
    </>
  );
}

const processSampledMessages = createSampler(
  (options: {
    messages: Message[];
    initialMessages: Message[];
    isLoading: boolean;
    parseMessages: (messages: Message[], isLoading: boolean) => void;
    storeMessageHistory: (messages: Message[]) => Promise<void>;
  }) => {
    const { messages, initialMessages, isLoading, parseMessages, storeMessageHistory } = options;
    parseMessages(messages, isLoading);

    if (messages.length > initialMessages.length) {
      storeMessageHistory(messages).catch((error) => toast.error(error.message));
    }
  },
  50,
);

interface ChatProps {
  initialMessages: Message[];
  storeMessageHistory: (messages: Message[]) => Promise<void>;
  importChat: (description: string, messages: Message[]) => Promise<void>;
  exportChat: () => void;
  description?: string;
}

export const ChatImpl = memo(
  ({ description, initialMessages, storeMessageHistory, importChat, exportChat }: ChatProps) => {
    useShortcuts();

    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [chatStarted, setChatStarted] = useState(initialMessages.length > 0);
    const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
    const [imageDataList, setImageDataList] = useState<string[]>([]);
    const [searchParams, setSearchParams] = useSearchParams();
    const [fakeLoading, setFakeLoading] = useState(false);
    const files = useStore(workbenchStore.files);
    const actionAlert = useStore(workbenchStore.alert);
    const { activeProviders, promptId, autoSelectTemplate, contextOptimizationEnabled } = useSettings();

    const [model, setModel] = useState(() => {
      const savedModel = Cookies.get('selectedModel');
      return savedModel || DEFAULT_MODEL;
    });
    const [provider, setProvider] = useState(() => {
      const savedProvider = Cookies.get('selectedProvider');
      return (PROVIDER_LIST.find((p) => p.name === savedProvider) || DEFAULT_PROVIDER) as ProviderInfo;
    });

    const { showChat } = useStore(chatStore);

    const [animationScope, animate] = useAnimate();

    const [apiKeys, setApiKeys] = useState<Record<string, string>>({});

    const {
      messages,
      isLoading,
      input,
      handleInputChange,
      setInput,
      stop,
      append,
      setMessages,
      reload,
      error,
      data: chatData,
      setData,
    } = useChat({
      api: '/api/chat',
      body: {
        apiKeys,
        files,
        promptId: promptId || 'default', // Default to 'default' if not set
        contextOptimization: contextOptimizationEnabled,
      },
      sendExtraMessageFields: true,
      onError: (e) => {
        logger.error('Request failed\n\n', e, error);
        logStore.logError('Chat request failed', e, {
          component: 'Chat',
          action: 'request',
          error: e.message,
        });
        toast.error(
          'There was an error processing your request: ' + (e.message ? e.message : 'No details were returned'),
        );
      },
      onFinish: (message, response) => {
        const usage = response.usage;
        setData(undefined);

        if (usage) {
          console.log('Token usage:', usage);
          logStore.logProvider('Chat response completed', {
            component: 'Chat',
            action: 'response',
            model,
            provider: provider.name,
            usage,
            messageLength: message.content.length,
          });
        }

        logger.debug('Finished streaming');
      },
      initialMessages,
      initialInput: Cookies.get(PROMPT_COOKIE_KEY) || '',
    });

    useEffect(() => {
      const prompt = searchParams.get('prompt');
      if (prompt) {
        setSearchParams({});
        runAnimation();
        append({
          role: 'user',
          content: `[Model: ${model}]\n\n[Provider: ${provider.name}]\n\n${prompt}`, // Changed to string format
          projectId: `project-${Date.now()}`, // Ensure projectId is included
        });
      }
    }, [model, provider, searchParams]);

    const { enhancingPrompt, promptEnhanced, enhancePrompt, resetEnhancer } = usePromptEnhancer();
    const { parsedMessages, parseMessages } = useMessageParser();

    const TEXTAREA_MAX_HEIGHT = chatStarted ? 400 : 200;

    useEffect(() => {
      chatStore.setKey('started', initialMessages.length > 0);
    }, []);

    useEffect(() => {
      processSampledMessages({
        messages,
        initialMessages,
        isLoading,
        parseMessages,
        storeMessageHistory,
      });
    }, [messages, isLoading, parseMessages]);

    const scrollTextArea = () => {
      const textarea = textareaRef.current;
      if (textarea) {
        textarea.scrollTop = textarea.scrollHeight;
      }
    };

    const abort = () => {
      stop();
      chatStore.setKey('aborted', true);
      workbenchStore.abortAllActions();
      logStore.logProvider('Chat response aborted', {
        component: 'Chat',
        action: 'abort',
        model,
        provider: provider.name,
      });
    };

    useEffect(() => {
      const textarea = textareaRef.current;
      if (textarea) {
        textarea.style.height = 'auto';
        const scrollHeight = textarea.scrollHeight;
        textarea.style.height = `${Math.min(scrollHeight, TEXTAREA_MAX_HEIGHT)}px`;
        textarea.style.overflowY = scrollHeight > TEXTAREA_MAX_HEIGHT ? 'auto' : 'hidden';
      }
    }, [input, textareaRef]);

    const runAnimation = async () => {
      if (chatStarted) return;
      await Promise.all([
        animate('#examples', { opacity: 0, display: 'none' }, { duration: 0.1 }),
        animate('#intro', { opacity: 0, flex: 1 }, { duration: 0.2, ease: cubicEasingFn }),
      ]);
      chatStore.setKey('started', true);
      setChatStarted(true);
    };

    const startNewProject = () => {
      const newProjectId = `project-${Date.now()}`; // Unique project ID
      setProjectId(newProjectId);
      setMessages([]); // Clear chat history for new project
      setInput(''); // Clear input field
      workbenchStore.resetAllFileModifications(); // Clear file modifications for new project
      setUploadedFiles([]); // Clear uploaded files
      setImageDataList([]); // Clear image data
      // Clear browser storage to prevent old data from persisting
      localStorage.removeItem('projectData'); // Remove specific project data (adjust key if needed)
      localStorage.clear(); // Clear all local storage (use cautiously, or be specific)
      sessionStorage.clear(); // Clear session storage
      logStore.log('New project started', {
        component: 'Chat',
        action: 'newProject',
        projectId: newProjectId,
      });
      // Navigate to ensure a clean state
      window.location.href = `?project=${newProjectId}`;
    };

    const sendMessage = async (_event: React.UIEvent, messageInput?: string) => {
      const messageContent = messageInput || input;
      if (!messageContent?.trim()) {
        toast.error('Message cannot be empty');
        return;
      }
      if (isLoading) {
        abort();
        return;
      }
      runAnimation();

      if (!chatStarted) {
        setFakeLoading(true);
        if (autoSelectTemplate) {
          const { template, title } = await selectStarterTemplate({
            message: messageContent,
            model,
            provider,
          });
          if (template !== 'blank') {
            const temResp = await getTemplates(template, title).catch((e) => {
              if (e.message.includes('rate limit')) {
                toast.warning('Rate limit exceeded. Skipping starter template\n Continuing with blank template');
              } else {
                toast.warning('Failed to import starter template\n Continuing with blank template');
              }
              return null;
            });
            if (temResp) {
              const { assistantMessage, userMessage } = temResp;
              const initialProjectId = projectId || `project-${Date.now()}`;
              setProjectId(initialProjectId);
              setMessages([
                {
                  id: `1-${new Date().getTime()}`,
                  role: 'user',
                  content: messageContent, // Changed to string format
                  projectId: initialProjectId,
                },
                {
                  id: `2-${new Date().getTime()}`,
                  role: 'assistant',
                  content: assistantMessage,
                  projectId: initialProjectId,
                },
                {
                  id: `3-${new Date().getTime()}`,
                  role: 'user',
                  content: `[Model: ${model}]\n\n[Provider: ${provider.name}]\n\n${userMessage}`, // String format
                  annotations: ['hidden'],
                  projectId: initialProjectId,
                },
              ]);
              reload();
              setFakeLoading(false);
              await saveChat(messageContent, 'user', model, null); // Save initial chat
              return;
            }
          }
        }
        const initialProjectId = projectId || `project-${Date.now()}`;
        setProjectId(initialProjectId);
        setMessages([
          {
            id: `${new Date().getTime()}`,
            role: 'user',
            content: `[Model: ${model}]\n\n[Provider: ${provider.name}]\n\n${messageContent}`, // Changed to string format
            projectId: initialProjectId,
          },
        ]);
        reload();
        setFakeLoading(false);
        await saveChat(messageContent, 'user', model, imageDataList.length > 0 ? imageDataList[0] : null); // Save initial chat
        return;
      }

      if (error != null) {
        setMessages(messages.slice(0, -1));
      }

      try {
        const modifiedFiles = workbenchStore.getModifiedFiles();
        chatStore.setKey('aborted', false);

        const content = `[Model: ${model}]\n\n[Provider: ${provider.name}]\n\n${messageContent}`; // String format

        if (modifiedFiles !== undefined && modifiedFiles.length > 0) {
          const userUpdateArtifact = filesToArtifacts(modifiedFiles, `${Date.now()}`);
          content = `[Model: ${model}]\n\n[Provider: ${provider.name}]\n\n${userUpdateArtifact}${messageContent}`; // String format
          append({
            role: 'user',
            content,
            projectId, // Include projectId for code storage isolation
          });
          workbenchStore.resetAllFileModifications();
        } else {
          append({
            role: 'user',
            content,
            projectId, // Include projectId for code storage isolation
          });
        }
      } catch (error) {
        logger.error('Error sending message:', error);
        toast.error('Failed to send message: ' + error.message);
        return;
      }

      await saveChat(messageContent, 'user', model, imageDataList.length > 0 ? imageDataList[0] : null);
      setInput('');
      Cookies.remove(PROMPT_COOKIE_KEY);
      setUploadedFiles([]);
      setImageDataList([]);
      resetEnhancer();
      textareaRef.current?.blur();
    };

    const onTextareaChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      handleInputChange(event);
    };

    const debouncedCachePrompt = useCallback(
      debounce((event: React.ChangeEvent<HTMLTextAreaElement>) => {
        const trimmedValue = event.target.value.trim();
        Cookies.set(PROMPT_COOKIE_KEY, trimmedValue, { expires: 30 });
      }, 1000),
      [],
    );

    const [messageRef, scrollRef] = useSnapScroll();

    useEffect(() => {
      const storedApiKeys = Cookies.get('apiKeys');
      if (storedApiKeys) {
        setApiKeys(JSON.parse(storedApiKeys));
      }
    }, []);

    const handleModelChange = (newModel: string) => {
      setModel(newModel);
      Cookies.set('selectedModel', newModel, { expires: 30 });
    };

    const handleProviderChange = (newProvider: ProviderInfo) => {
      setProvider(newProvider);
      Cookies.set('selectedProvider', newProvider.name, { expires: 30 });
    };

    // Define supported providers
    const supportedProviders = ['openrouter', 'anthropic', 'openai'];
    const providerName = provider?.name?.toLowerCase() || 'openrouter'; // Default to openrouter

    // Set API keys dynamically based on provider
    useEffect(() => {
      if (!apiKeys[providerName] && supportedProviders.includes(providerName)) {
        const envKey = process.env[`${providerName.toUpperCase()}_API_KEY`] || '';
        const promptedKey = envKey || prompt(`Please enter your ${providerName} API key:`);
        if (promptedKey) {
          setApiKeys((prev) => ({ ...prev, [providerName]: promptedKey }));
          Cookies.set('apiKeys', JSON.stringify({ ...apiKeys, [providerName]: promptedKey }), { expires: 30 });
        }
      }
    }, [providerName, apiKeys]);

    // Allow all models from supported providers
    const validModels = [
      'xai/grok-4o', // OpenRouter free model
      'google/gemini-2.0-flash-thinking-exp-1219:free', // OpenRouter free model
      'anthropic/claude-3.5-sonnet', // Anthropic model
      'openai/gpt-4o-mini', // OpenAI model
    ];
    const finalModel = validModels.includes(model) ? model : 'xai/grok-4o'; // Default to a free model

    // Enhanced enhancePrompt with direct fetch, project isolation, and resource limit optimization
    const enhancePromptOptimized = async () => {
      if (!input?.trim()) {
        toast.error('Please enter a prompt to enhance');
        return;
      }

      const apiKey = apiKeys[providerName] || process.env.OPENROUTER_API_KEY || '';
      if (!apiKey) {
        toast.error(`API key for ${providerName} is missing. Please set it in settings or environment variables.`);
        return;
      }

      const requestBody = {
        input: input.trim(),
        model: finalModel,
        provider_name: providerName,
        api_key: apiKey,
        project_id: projectId, // Include projectId to scope enhancement requests
      };
      console.log('Enhancing prompt with request:', requestBody);

      try {
        const response = await fetch('/api/enhancer', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        });
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
        }
        const data = await response.json();
        console.log('Enhanced prompt result:', data);
        setInput(data.enhanced || input); // Use 'enhanced' or fallback to original
        scrollTextArea();
        logStore.log('Prompt enhanced successfully', {
          component: 'Chat',
          action: 'enhancePrompt',
          provider: providerName,
          model: finalModel,
          projectId,
        });
        await saveChat(data.enhanced || input, 'system', finalModel, null); // Save enhanced prompt with projectId
      } catch (err) {
        console.error('Enhance prompt failed:', err, 'Request:', requestBody);
        toast.error('Failed to enhance prompt: ' + err.message);
      }
    };

    // Save and load chats specific to the project
    const saveChat = async (message: string, sender: string, model: string, image: string | null = null) => {
      if (!projectId) {
        throw new Error('Project ID is not set');
      }
      if (!message.trim() || !sender.trim()) {
        throw new Error('Message content and sender role cannot be empty');
      }
      console.log('Attempting to save chat:', { message, sender, model, image, projectId });
      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [{ content: message.trim(), role: sender.trim() }],
            files: {},
            projectId,
            model,
            image,
            promptId: promptId || 'default', // Include promptId, default to 'default'
          }),
        });
        const responseText = await response.text();
        console.log('Save chat response:', response.status, responseText);
        if (!response.ok) {
          throw new Error(`API error: ${response.status} - ${responseText}`);
        }
      } catch (err) {
        console.error('Failed to save chat:', err);
        toast.error('Could not save chat message: ' + err.message);
      }
    };

    const loadChats = async () => {
      try {
        const response = await fetch(`/api/chat?projectId=${projectId}`, {
          method: 'GET',
        });
        if (!response.ok) throw new Error('Failed to fetch chats');
        const chats = await response.json();
        const formattedChats = chats.map((chat) => ({
          id: chat.id.toString(),
          role: chat.sender === 'user' ? 'user' : 'assistant',
          content: chat.image_url
            ? `[Model: ${model}]\n\n[Provider: ${provider.name}]\n\n${chat.message}\n[Image: ${chat.image_url}]` // String format with image info
            : `[Model: ${model}]\n\n[Provider: ${provider.name}]\n\n${chat.message}`, // String format
        }));
        setMessages(formattedChats);
      } catch (err) {
        console.error('Failed to load chats for project ' + projectId + ':', err);
        toast.error('Could not load chat history');
      }
    };

    useEffect(() => {
      loadChats();
    }, [projectId]);

    // Trigger a new project via URL or other mechanisms (e.g., navigation)
    useEffect(() => {
      const url = new URL(window.location.href);
      const projectParam = url.searchParams.get('project');
      if (projectParam) {
        startNewProject(); // Trigger new project
        setSearchParams({});
      } else if (!projectId) {
        // Ensure projectId is set if no URL parameter
        startNewProject();
      }
    }, [setSearchParams, projectId]);

    return (
      <BaseChat
        ref={animationScope}
        textareaRef={textareaRef}
        input={input}
        showChat={showChat}
        chatStarted={chatStarted}
        isStreaming={isLoading || fakeLoading}
        onStreamingChange={(streaming) => {
          streamingState.set(streaming);
        }}
        enhancingPrompt={enhancingPrompt}
        promptEnhanced={promptEnhanced}
        sendMessage={sendMessage}
        model={model}
        setModel={handleModelChange}
        provider={provider}
        setProvider={handleProviderChange}
        providerList={activeProviders}
        messageRef={messageRef}
        scrollRef={scrollRef}
        handleInputChange={(e) => {
          onTextareaChange(e);
          debouncedCachePrompt(e);
        }}
        handleStop={abort}
        description={description}
        importChat={importChat}
        exportChat={exportChat}
        messages={messages.map((message, i) => {
          if (message.role === 'user') {
            return message;
          }
          return {
            ...message,
            content: parsedMessages[i] || '',
          };
        })}
        enhancePrompt={() => {
          enhancePrompt(
            input,
            (input) => {
              setInput(input);
              scrollTextArea();
            },
            model,
            provider,
            apiKeys,
          );
        }}
        uploadedFiles={uploadedFiles}
        setUploadedFiles={setUploadedFiles}
        imageDataList={imageDataList}
        setImageDataList={setImageDataList}
        actionAlert={actionAlert}
        clearAlert={() => workbenchStore.clearAlert()}
        data={chatData}
      />
    );
  },
);
