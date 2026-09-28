// Generated from the pinned PSSS Argo 3.4.2 source and policy overlay.
export const PROFILE_SHA256="b2ae3e74b70bd617f08cab5ef2a7e555bc0d586d0e9feefa4520e922488fa012";
export const PROFILE={
  "schema": "opensphere.psss-argocd-rbac-transition/v1",
  "owner": "platform-support",
  "namespace": "argocd",
  "source": {
    "repository": "https://github.com/opensphere-platform/OpenSphere-Platform-Support",
    "policyRevision": "c574778de687d8ee3406878e1f2794f579795ac4",
    "originalBundleSha256": "ca5b9adbefd7efed7dea66d9fc4f0de2aaa382f5adf28e8824097a0e2a376f37",
    "policyId": "opensphere.argocd-core-policy/v2"
  },
  "resources": [
    {
      "kind": "Role",
      "name": "argocd-application-controller",
      "namespace": "argocd",
      "previous": [
        {
          "apiGroups": [
            ""
          ],
          "resources": [
            "secrets",
            "configmaps"
          ],
          "verbs": [
            "get",
            "list",
            "watch"
          ]
        },
        {
          "apiGroups": [
            "argoproj.io"
          ],
          "resources": [
            "applications",
            "applicationsets",
            "appprojects"
          ],
          "verbs": [
            "create",
            "get",
            "list",
            "watch",
            "update",
            "patch",
            "delete"
          ]
        },
        {
          "apiGroups": [
            ""
          ],
          "resources": [
            "events"
          ],
          "verbs": [
            "create",
            "list"
          ]
        },
        {
          "apiGroups": [
            "apps"
          ],
          "resources": [
            "deployments"
          ],
          "verbs": [
            "get",
            "list",
            "watch"
          ]
        }
      ],
      "next": [
        {
          "apiGroups": [
            ""
          ],
          "resources": [
            "secrets",
            "configmaps"
          ],
          "verbs": [
            "get",
            "list",
            "watch"
          ]
        },
        {
          "apiGroups": [
            "argoproj.io"
          ],
          "resources": [
            "applications",
            "applicationsets",
            "appprojects"
          ],
          "verbs": [
            "get",
            "list",
            "watch"
          ]
        },
        {
          "apiGroups": [
            "argoproj.io"
          ],
          "resources": [
            "applications/status",
            "applications/finalizers"
          ],
          "verbs": [
            "get",
            "patch",
            "update"
          ]
        },
        {
          "apiGroups": [
            ""
          ],
          "resources": [
            "events"
          ],
          "verbs": [
            "create",
            "list"
          ]
        },
        {
          "apiGroups": [
            "apps"
          ],
          "resources": [
            "deployments"
          ],
          "verbs": [
            "get",
            "list",
            "watch"
          ]
        }
      ]
    },
    {
      "kind": "Role",
      "name": "argocd-applicationset-controller",
      "namespace": "argocd",
      "previous": [
        {
          "apiGroups": [
            "argoproj.io"
          ],
          "resources": [
            "applications",
            "applicationsets",
            "applicationsets/finalizers"
          ],
          "verbs": [
            "create",
            "delete",
            "get",
            "list",
            "patch",
            "update",
            "watch"
          ]
        },
        {
          "apiGroups": [
            "argoproj.io"
          ],
          "resources": [
            "appprojects"
          ],
          "verbs": [
            "get",
            "list",
            "watch"
          ]
        },
        {
          "apiGroups": [
            "argoproj.io"
          ],
          "resources": [
            "applicationsets/status"
          ],
          "verbs": [
            "get",
            "patch",
            "update"
          ]
        },
        {
          "apiGroups": [
            ""
          ],
          "resources": [
            "events"
          ],
          "verbs": [
            "create",
            "get",
            "list",
            "patch",
            "watch"
          ]
        },
        {
          "apiGroups": [
            ""
          ],
          "resources": [
            "secrets",
            "configmaps"
          ],
          "verbs": [
            "get",
            "list",
            "watch"
          ]
        },
        {
          "apiGroups": [
            "coordination.k8s.io"
          ],
          "resources": [
            "leases"
          ],
          "verbs": [
            "create"
          ]
        },
        {
          "apiGroups": [
            "coordination.k8s.io"
          ],
          "resourceNames": [
            "58ac56fa.applicationsets.argoproj.io"
          ],
          "resources": [
            "leases"
          ],
          "verbs": [
            "get",
            "update",
            "create"
          ]
        }
      ],
      "next": [
        {
          "apiGroups": [
            "argoproj.io"
          ],
          "resources": [
            "applications",
            "applicationsets",
            "appprojects"
          ],
          "verbs": [
            "get",
            "list",
            "watch"
          ]
        },
        {
          "apiGroups": [
            "argoproj.io"
          ],
          "resources": [
            "applicationsets/status",
            "applicationsets/finalizers"
          ],
          "verbs": [
            "get",
            "patch",
            "update"
          ]
        },
        {
          "apiGroups": [
            ""
          ],
          "resources": [
            "events"
          ],
          "verbs": [
            "create",
            "get",
            "list",
            "patch",
            "watch"
          ]
        },
        {
          "apiGroups": [
            ""
          ],
          "resources": [
            "secrets",
            "configmaps"
          ],
          "verbs": [
            "get",
            "list",
            "watch"
          ]
        },
        {
          "apiGroups": [
            "coordination.k8s.io"
          ],
          "resources": [
            "leases"
          ],
          "verbs": [
            "create"
          ]
        },
        {
          "apiGroups": [
            "coordination.k8s.io"
          ],
          "resources": [
            "leases"
          ],
          "resourceNames": [
            "58ac56fa.applicationsets.argoproj.io"
          ],
          "verbs": [
            "get",
            "update",
            "create"
          ]
        }
      ]
    },
    {
      "kind": "Role",
      "name": "argocd-server",
      "namespace": "argocd",
      "previous": [
        {
          "apiGroups": [
            ""
          ],
          "resources": [
            "secrets",
            "configmaps"
          ],
          "verbs": [
            "create",
            "get",
            "list",
            "watch",
            "update",
            "patch",
            "delete"
          ]
        },
        {
          "apiGroups": [
            "argoproj.io"
          ],
          "resources": [
            "applications",
            "appprojects",
            "applicationsets"
          ],
          "verbs": [
            "create",
            "get",
            "list",
            "watch",
            "update",
            "delete",
            "patch"
          ]
        },
        {
          "apiGroups": [
            ""
          ],
          "resources": [
            "events"
          ],
          "verbs": [
            "create",
            "list"
          ]
        }
      ],
      "next": [
        {
          "apiGroups": [
            ""
          ],
          "resources": [
            "secrets",
            "configmaps"
          ],
          "verbs": [
            "get",
            "list",
            "watch"
          ]
        },
        {
          "apiGroups": [
            "argoproj.io"
          ],
          "resources": [
            "applications",
            "appprojects",
            "applicationsets"
          ],
          "verbs": [
            "get",
            "list",
            "watch"
          ]
        },
        {
          "apiGroups": [
            ""
          ],
          "resources": [
            "events"
          ],
          "verbs": [
            "create",
            "list"
          ]
        }
      ]
    },
    {
      "kind": "ClusterRole",
      "name": "argocd-application-controller",
      "namespace": null,
      "previous": [
        {
          "apiGroups": [
            "*"
          ],
          "resources": [
            "*"
          ],
          "verbs": [
            "*"
          ]
        },
        {
          "nonResourceURLs": [
            "*"
          ],
          "verbs": [
            "*"
          ]
        }
      ],
      "next": [
        {
          "apiGroups": [
            ""
          ],
          "resources": [
            "namespaces"
          ],
          "verbs": [
            "get",
            "list",
            "watch"
          ]
        }
      ]
    },
    {
      "kind": "ClusterRole",
      "name": "argocd-applicationset-controller",
      "namespace": null,
      "previous": [
        {
          "apiGroups": [
            "argoproj.io"
          ],
          "resources": [
            "applications",
            "applicationsets",
            "applicationsets/finalizers"
          ],
          "verbs": [
            "create",
            "delete",
            "get",
            "list",
            "patch",
            "update",
            "watch"
          ]
        },
        {
          "apiGroups": [
            "argoproj.io"
          ],
          "resources": [
            "appprojects"
          ],
          "verbs": [
            "get",
            "list",
            "watch"
          ]
        },
        {
          "apiGroups": [
            "argoproj.io"
          ],
          "resources": [
            "applicationsets/status"
          ],
          "verbs": [
            "get",
            "patch",
            "update"
          ]
        },
        {
          "apiGroups": [
            ""
          ],
          "resources": [
            "events"
          ],
          "verbs": [
            "create",
            "get",
            "list",
            "patch",
            "watch"
          ]
        },
        {
          "apiGroups": [
            ""
          ],
          "resources": [
            "secrets",
            "configmaps"
          ],
          "verbs": [
            "get",
            "list",
            "watch"
          ]
        },
        {
          "apiGroups": [
            "coordination.k8s.io"
          ],
          "resources": [
            "leases"
          ],
          "verbs": [
            "create"
          ]
        },
        {
          "apiGroups": [
            "coordination.k8s.io"
          ],
          "resourceNames": [
            "58ac56fa.applicationsets.argoproj.io"
          ],
          "resources": [
            "leases"
          ],
          "verbs": [
            "get",
            "update",
            "create"
          ]
        }
      ],
      "next": [
        {
          "apiGroups": [
            ""
          ],
          "resources": [
            "namespaces"
          ],
          "verbs": [
            "get",
            "list",
            "watch"
          ]
        }
      ]
    },
    {
      "kind": "ClusterRole",
      "name": "argocd-server",
      "namespace": null,
      "previous": [
        {
          "apiGroups": [
            "*"
          ],
          "resources": [
            "*"
          ],
          "verbs": [
            "delete",
            "get",
            "patch"
          ]
        },
        {
          "apiGroups": [
            ""
          ],
          "resources": [
            "events"
          ],
          "verbs": [
            "list"
          ]
        },
        {
          "apiGroups": [
            ""
          ],
          "resources": [
            "pods",
            "pods/log"
          ],
          "verbs": [
            "get"
          ]
        },
        {
          "apiGroups": [
            "argoproj.io"
          ],
          "resources": [
            "applications",
            "applicationsets"
          ],
          "verbs": [
            "get",
            "list",
            "watch"
          ]
        },
        {
          "apiGroups": [
            "batch"
          ],
          "resources": [
            "jobs"
          ],
          "verbs": [
            "create"
          ]
        },
        {
          "apiGroups": [
            "argoproj.io"
          ],
          "resources": [
            "workflows"
          ],
          "verbs": [
            "create"
          ]
        }
      ],
      "next": [
        {
          "apiGroups": [
            ""
          ],
          "resources": [
            "namespaces"
          ],
          "verbs": [
            "get",
            "list",
            "watch"
          ]
        }
      ]
    }
  ]
};
