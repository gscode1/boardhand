{{- define "boardhand.boardName" -}}
{{- printf "%s-board" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Call with (dict "root" $ "route" $route). */}}
{{- define "boardhand.workerName" -}}
{{- printf "%s-worker-%s" .root.Release.Name .route.name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "boardhand.boardUrl" -}}
{{- .Values.board.publicUrl | default (printf "http://%s.%s.svc:8080" (include "boardhand.boardName" .) .Release.Namespace) | trimSuffix "/" -}}
{{- end -}}

{{- define "boardhand.image" -}}
{{- printf "%s:%s" .Values.image.repository (required "image.tag is required" .Values.image.tag) -}}
{{- end -}}

{{/* Call with (dict "root" $ "component" "board" "route" "dev"?). */}}
{{- define "boardhand.labels" -}}
app.kubernetes.io/name: boardhand
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version | replace "+" "_" }}
{{- if .route }}
boardhand/route: {{ .route }}
{{- end }}
{{- end -}}

{{- define "boardhand.selectorLabels" -}}
app.kubernetes.io/name: boardhand
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- if .route }}
boardhand/route: {{ .route }}
{{- end }}
{{- end -}}

{{/* Pod Security `restricted`: non-root, no privilege escalation, no capabilities, seccomp RuntimeDefault. */}}
{{- define "boardhand.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: 10001
runAsGroup: 10001
fsGroup: 10001
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "boardhand.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
runAsNonRoot: true
capabilities:
  drop: ["ALL"]
{{- end -}}

{{/* NetworkPolicy ports from a list of numbers or {port, protocol, endPort} maps. */}}
{{- define "boardhand.ports" -}}
{{- range . }}
{{- if kindIs "map" . }}
- protocol: {{ .protocol | default "TCP" }}
  port: {{ int (required "a port entry needs port" .port) }}
  {{- if .endPort }}
  endPort: {{ int .endPort }}
  {{- end }}
{{- else }}
- protocol: TCP
  port: {{ int . }}
{{- end }}
{{- end }}
{{- end -}}

{{/*
One egress rule from a route egress entry: {namespace, podSelector?, ports} or {cidr, ports}.
Call with (dict "entry" $e "where" "route dev").
*/}}
{{- define "boardhand.egressRule" -}}
{{- $e := .entry -}}
{{- if not $e.ports }}{{ fail (printf "%s: an egress entry needs ports" .where) }}{{ end -}}
{{- if and $e.cidr $e.namespace }}{{ fail (printf "%s: an egress entry takes namespace or cidr, not both" .where) }}{{ end -}}
{{- if not (or $e.cidr $e.namespace) }}{{ fail (printf "%s: an egress entry needs namespace or cidr" .where) }}{{ end -}}
- to:
    {{- if $e.cidr }}
    - ipBlock:
        cidr: {{ $e.cidr | quote }}
    {{- else }}
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: {{ $e.namespace | quote }}
      {{- if $e.podSelector }}
      podSelector:
        matchLabels:
          {{- toYaml $e.podSelector | nindent 10 }}
      {{- end }}
    {{- end }}
  ports:
    {{- include "boardhand.ports" $e.ports | trim | nindent 4 }}
{{- end -}}
