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
    const [projectId, setProjectId] = useState(`project-${Date.now()}`); // Unique ID for each project, hidden from UI
    const files = useStore(workbenchStore.files);
    const actionAlert = useStore(workbenchStore.alert);
    const { activeProviders, promptId, autoSelectTemplate, contextOptimizationEnabled } = useSettings();

    const [model, setModel] = useState(() => {
      const savedModel = Cookies.get('selectedModel');
      return savedModel || 'xai/grok-4o'; // Default to free Grok model
    });
    const [provider, setProvider] = useState(() => {
      const savedProvider = Cookies.get('selectedProvider');
      return (PROVIDER_LIST.find((p) => p.name.toLowerCase() === savedProvider?.toLowerCase()) || DEFAULT_PROVIDER) as ProviderInfo;
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
        projectId, // Pass projectId to API for chat and code isolation
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
          content: [
            {
              type: 'text',
              text: `[Model: ${model}]\n\n[Provider: ${provider.name}]\n\n${prompt}`,
            },
          ] as any,
          projectId, // Include projectId for new chats
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
        action:
