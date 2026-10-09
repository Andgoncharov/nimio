const registry = new Set();

export function singleInstanceService(Klass) {
  let instance;
  return {
    getInstance: function () {
      if (!instance) {
        instance = new Klass();
        instance.constructor = null;
      }
      return instance;
    },
  };
}

export function multiInstanceService(Klass) {
  const instances = new Map();
  const service = {
    getInstance(instanceId) {
      if (!instanceId) {
        console.error("multiInstance getInstance is called without instanceId");
        return null;
      }
      let inst = instances.get(instanceId);
      if (!inst) {
        inst = new Klass(instanceId);
        inst.constructor = null;
        instances.set(instanceId, inst);
      }
      return inst;
    },

    hasInstance(instanceId) {
      return instances.has(instanceId);
    },

    // Evicts the cached object for instanceId and runs its destroy() hook,
    // if the class defines one. Returns true when something was evicted.
    releaseInstance(instanceId) {
      const inst = instances.get(instanceId);
      if (!inst) return false;

      instances.delete(instanceId);
      if (typeof inst.destroy === "function") {
        try {
          inst.destroy();
        } catch (err) {
          console.error(`Service destroy failed for ${instanceId}`, err);
        }
      }
      return true;
    },
  };
  registry.add(service);
  return service;
}

// Releases instanceId from every multi-instance service. Returns the number
// of services that held it.
export function releaseInstances(instanceId) {
  let count = 0;
  for (const service of registry) {
    if (service.releaseInstance(instanceId)) count++;
  }
  return count;
}

export function hasInstances(instanceId) {
  if (!instanceId) return false;
  for (const service of registry) {
    if (service.hasInstance(instanceId)) return true;
  }
  return false;
}
