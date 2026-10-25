<svelte:options customElement="mv-trajectory" />

<script lang="ts">
  import { Trajectory } from 'matterviz'

  interface Props {
    data_url?: string
  }
  let { data_url = undefined }: Props = $props()
</script>

{#if data_url}
  <Trajectory {data_url} allow_file_drop={false} layout="auto" style="width: 100%; height: 100%" />
{/if}

<style>
  :host {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
