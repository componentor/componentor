<template>
  <div style="display: flex; flex-direction: column; flex-grow: 1; position: relative;">
    <div v-if="loading" class="loading-spinner">
      <div class="spinner"></div>
    </div>
    <iframe
      sandbox="allow-downloads allow-scripts allow-same-origin allow-popups allow-modals"
      id="vueplay"
      :src="origin + '/p' + subpath + '#?root=root&repository=' + base + '/api/v1/git/bare.git&token=' + tokens?.accessToken"
      @load="loading = false"
    />
  </div>
</template>
<script>
export default {
  inject: ['apiFetch', 'apiBase', 'navTree', 'tokens'],
  props: ['sub', 'slug'],
  data() {
    return {
      subpath: ('/' + location.hash.replace('#', '')).replace('//', '/'),
      loading: true
    }
  },
  computed: {
    origin() {
      return location.origin.includes('http://localhost:') ? 'http://localhost:3000' : 'https://studio.vueplay.com'
    },
    base() {
      if (this.apiBase?.startsWith('http')) return this.apiBase
      return location.origin + this.apiBase
    }
  },
  mounted() {
    window.addEventListener('hashchange', this.onHashChange)
  },
  beforeUnmount() {
    window.removeEventListener('hashchange', this.onHashChange)
  },
  methods: {
    onHashChange() {
      this.subpath = ('/' + location.hash.replace('#', '')).replace('//', '/')
    }
  }
}
</script>

<style>
  #vueplay {
    height: 100%;
    width: 100%;
    border: none;
    outline: none;
    box-shadow: none;
    flex-grow: 1;
  }
  .loading-spinner {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.9);
    z-index: 10;
  }
  .spinner {
    width: 40px;
    height: 40px;
    border: 3px solid #e0e0e0;
    border-top-color: #333;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
