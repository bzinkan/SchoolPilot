import { useCallback, useEffect, useRef, useState } from 'react';

import { createKioskPollingController } from './kioskController';

const INITIAL_STATUS = {
  isPolling: false,
  isOffline: false,
  consecutiveFailures: 0,
  lastSuccessAt: null,
  latestDataRevision: null,
};

export function useKioskPollingController({
  enabled,
  controllerKey,
  request,
  onResult,
  onError,
  onHealthEvent,
  getRevision,
}) {
  const handlersRef = useRef({ request, onResult, onError, onHealthEvent, getRevision });
  const controllerRef = useRef(null);
  const [status, setStatus] = useState(INITIAL_STATUS);

  useEffect(() => {
    handlersRef.current = { request, onResult, onError, onHealthEvent, getRevision };
  }, [getRevision, onError, onHealthEvent, onResult, request]);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    const controller = createKioskPollingController({
      request: (context) => handlersRef.current.request(context),
      onResult: (result, context) => handlersRef.current.onResult(result, context),
      onError: (error, context) => handlersRef.current.onError(error, context),
      onHealthEvent: (event, context) => handlersRef.current.onHealthEvent?.(event, context),
      getRevision: (result) => handlersRef.current.getRevision?.(result) ?? result?.revision ?? null,
      onStatus: setStatus,
    });
    controllerRef.current = controller;
    controller.start();

    return () => {
      controller.stop();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [enabled, controllerKey]);

  const refresh = useCallback(() => controllerRef.current?.refresh(), []);
  const beginMutation = useCallback(() => {
    const controller = controllerRef.current;
    if (!controller) return null;
    return { controller, epoch: controller.beginMutation() };
  }, []);
  const isMutationCurrent = useCallback((mutation) => (
    Boolean(mutation)
    && controllerRef.current === mutation.controller
    && mutation.controller.isMutationCurrent(mutation.epoch)
  ), []);
  const completeMutation = useCallback((mutation, options) => {
    if (!mutation || controllerRef.current !== mutation.controller) return false;
    return mutation.controller.completeMutation(mutation.epoch, options);
  }, []);

  return {
    ...status,
    refresh,
    beginMutation,
    isMutationCurrent,
    completeMutation,
  };
}
